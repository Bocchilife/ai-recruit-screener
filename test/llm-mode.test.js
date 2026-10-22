/**
 * LLM 链路的自动化测试：本机没有 API Key，所以起一个假的 OpenAI 兼容服务，
 * 用它验证真实会走的代码路径——请求形状（json_mode / Bearer 头）、
 * JSON 围栏容错、模型判定与证据回验、以及模型挂掉时的降级。
 * 这样"有 Key 就真调、没 Key 就降级"这句话才是被测试过的，而不是只写在 README 里。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const APP_PORT = 5197;
const MOCK_PORT = 5198;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const DATA_DIR = 'data/.test-llm';
const KEY = 'test-key';

const RUBRICS = [
  { id: 'must_major', group: 'must', label: '计算机/软件工程相关专业', weight: 8, type: 'education', probe: '学历与专业' },
  { id: 'must_code', group: 'must', label: '具备 Python 编程能力', weight: 8, type: 'skill', probe: '项目里的代码' },
  { id: 'nice_ai', group: 'nice', label: '有大模型应用经验', weight: 5, type: 'skill', probe: 'AI 项目经历' },
];

// 模型"编"的这句话简历里没有，用来验证证据回验能抓到
const FABRICATED = '精通 Golang 高并发架构设计';

let app;
let mock;
let stderr = '';
let mockMode = 'happy'; // happy | fail
const seen = []; // 记录收到的每个请求，用于断言请求形状

async function api(pathname, options) {
  const res = await fetch(BASE + pathname, options);
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  return { status: res.status, body: isJson ? await res.json() : await res.text() };
}

const json = (res, obj, status = 200) => {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
};

const completion = (content, usage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }) => ({
  choices: [{ message: { role: 'assistant', content } }],
  usage,
});

/** 按 system prompt 区分是哪一段调用，返回结构对应的 JSON */
function respond(messages) {
  const system = messages?.[0]?.content || '';
  const user = messages?.[1]?.content || '';

  if (system.includes('拆成可判定的评估项')) {
    // 故意包一层 ```json 围栏：模型经常这么干，extractJSON 必须能兜住
    const payload = {
      role: 'AI 自动化项目实习生',
      seniority: '实习',
      summary: '找一个能把 AI 落到真实业务里的计算机专业学生',
      rubrics: RUBRICS,
    };
    return '```json\n' + JSON.stringify(payload) + '\n```';
  }

  if (system.includes('简历分析器')) {
    const resume = (user.match(/<resume>([\s\S]*)<\/resume>/) || [])[1] || '';
    const lines = resume.split('\n').map((s) => s.trim()).filter((s) => s.length > 8);
    // 从原文里挑一句真实存在的片段当证据，让回验能通过
    const realQuote = (lines.find((l) => /大学|学院/.test(l)) || lines[0] || 'Python').slice(0, 40);
    // 用户消息里带着这次的评估项，按它逐条给判定（真实链路也是这样一问一答）
    const rubricJson = (user.match(/评估项（JSON）：\s*(\[[\s\S]*?\])\s*\n\n简历原文/) || [])[1];
    let rubrics = RUBRICS;
    try {
      if (rubricJson) rubrics = JSON.parse(rubricJson);
    } catch {
      /* 用默认的 */
    }
    const verdicts = rubrics.map((r) => {
      if (r.id === 'nice_ai') {
        return { rubric_id: 'nice_ai', verdict: 'missing', confidence: 0.8, evidence: [FABRICATED], reason: '模型自称有证据' };
      }
      if (r.group === 'redline') {
        // 关键回归场景：模型对"红线里的坏情况"答 missing（它不成立），这曾经被当成"命中红线"
        return { rubric_id: r.id, verdict: 'missing', confidence: 0.9, evidence: [realQuote], reason: '简历没有出现该负面情况' };
      }
      return { rubric_id: r.id, verdict: 'met', confidence: 0.85, evidence: [realQuote], reason: '满足' };
    });
    return JSON.stringify({
      profile: {
        name: '张思远',
        education: { degree: '本科', school: '中山大学', major: '计算机科学与技术', status: '在读' },
        skills: ['Python', 'FastAPI'],
        availability: '可实习 6 个月',
      },
      verdicts,
    });
  }

  if (system.includes('招聘协调员')) {
    return JSON.stringify({
      headline: '计算机在读，AI 项目能上手',
      strengths: ['计算机专业在读', '有 Python 项目经验'],
      risks: ['大模型应用经验未被简历证实'],
      questions: ['简历里那条 Golang 高并发经历能展开说说吗？'],
      message: '你好，我是 HR，看到你的计算机专业背景和 AI 项目经历，想约 10 分钟聊聊岗位细节。',
    });
  }

  throw new Error('未识别的 prompt');
}

before(async () => {
  fs.rmSync(path.join(ROOT, DATA_DIR), { recursive: true, force: true });

  mock = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        /* ignore */
      }
      seen.push({ url: req.url, auth: req.headers.authorization, body });

      if (mockMode === 'fail') {
        return json(res, { error: { message: 'mock upstream is down' } }, 500);
      }
      try {
        json(res, completion(respond(body.messages)));
      } catch (err) {
        json(res, { error: { message: err.message } }, 400);
      }
    });
  });
  await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));

  app = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      DATA_DIR,
      OPENAI_API_KEY: KEY,
      OPENAI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
      OPENAI_MODEL: 'mock-model',
      DEMO_FORCE_RULE: '',
      LLM_RETRIES: '0', // 失败路径不要退避等待，测试要快
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  app.stderr.on('data', (b) => (stderr += b.toString()));

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const { body } = await api('/api/health');
      if (body.ok) return;
    } catch {
      /* 还没起来 */
    }
    await sleep(150);
  }
  throw new Error(`服务没起来：${stderr}`);
});

after(async () => {
  app?.kill();
  mock?.close();
  await sleep(300);
  fs.rmSync(path.join(ROOT, DATA_DIR), { recursive: true, force: true });
});

async function waitRun(runId, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = (await api(`/api/run/${runId}`)).body;
    if (run?.status === 'done') return run;
    await sleep(250);
  }
  throw new Error(`run ${runId} 超时未完成`);
}

test('LLM 模式：请求形状正确、模型判定被采用、伪造证据被标记', { timeout: 90000 }, async () => {
  const health = (await api('/api/health')).body;
  assert.equal(health.mode, 'llm', '配了 Key 就该走 LLM 模式');

  const sample = (await api('/api/sample-jd')).body;
  const parsedRes = await api('/api/jd/parse', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jd: sample.jd }),
  });
  assert.equal(parsedRes.status, 200, stderr);
  const parsed = parsedRes.body;
  assert.equal(parsed.mode, 'llm');
  // 模型返回的 id 被原样采用（而不是被规则模板顶掉），院校层次加分项由代码补齐
  assert.deepEqual(parsed.rubrics.map((r) => r.id), [...RUBRICS.map((r) => r.id), 'nice_school']);

  // 请求形状：OpenAI 兼容 + JSON 模式 + Bearer 鉴权 + 指定模型
  const first = seen.at(-1);
  assert.equal(first.url, '/v1/chat/completions');
  assert.equal(first.auth, `Bearer ${KEY}`);
  assert.equal(first.body.model, 'mock-model');
  assert.deepEqual(first.body.response_format, { type: 'json_object' });

  const files = (await api('/api/samples')).body.samples.map((s) => s.name);
  const target = files.find((f) => /^01/.test(f));
  assert.ok(target, '缺少 01 号样例');

  const started = await api('/api/screen', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jd: parsed, samples: [target] }),
  });
  assert.equal(started.status, 202, JSON.stringify(started.body));

  const run = await waitRun(started.body.runId);
  const cand = run.candidates.find((c) => c.status === 'done');
  assert.ok(cand, `候选人不该失败：${JSON.stringify(run.candidates)}`);
  assert.equal(cand.mode, 'llm');
  assert.equal(cand.degraded, false);

  const detail = (await api(`/api/candidate/${cand.id}`)).body;
  // 判定来自模型，而不是规则引擎：一条 met、一条伪造证据的 missing
  assert.equal(detail.score.items.length, RUBRICS.length + 1);
  const ai = detail.score.items.find((i) => i.id === 'nice_ai');
  assert.equal(ai.verdict, 'missing');
  assert.equal(ai.evidence.length, 1);
  // 模型引用的原文在简历里找不到 → 必须被标为未核验，不能让 HR 以为有据可查
  assert.equal(ai.evidence[0].verified, false);
  const major = detail.score.items.find((i) => i.id === 'must_major');
  assert.equal(major.verdict, 'met');
  assert.ok(major.evidence.every((e) => e.verified), '真实原文片段应通过回验');

  // 院校层次：模型没给这条判定，代码按公开事实补齐（中山大学 = 985 → met / ×1）
  const school = detail.score.items.find((i) => i.id === 'nice_school');
  assert.equal(school.verdict, 'met', '985 院校应判符合');
  assert.equal(school.factor, 1);
  assert.match(school.reason, /985/);

  // 结论文案也来自模型（模板不会写这句话）
  assert.equal(detail.summary.headline, '计算机在读，AI 项目能上手');
  // 规则追问仍然兜底并入，模型漏掉的缺口不会被静默吞掉
  assert.ok(detail.summary.questions.length >= 1);
});

test('模型挂掉时降级规则引擎，整批不中断', { timeout: 60000 }, async () => {
  mockMode = 'fail';
  try {
    const files = (await api('/api/samples')).body.samples.map((s) => s.name);
    const target = files.find((f) => /^01/.test(f));
    const started = await api('/api/screen', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jd: { role: 'AI 自动化实习生', rubrics: RUBRICS }, samples: [target] }),
    });
    assert.equal(started.status, 202, JSON.stringify(started.body));

    const run = await waitRun(started.body.runId, 40000);
    const cand = run.candidates[0];
    assert.equal(cand.status, 'done', '模型失败不能让候选人变失败');
    assert.equal(cand.mode, 'rule');
    assert.equal(cand.degraded, true);

    const detail = (await api(`/api/candidate/${cand.id}`)).body;
    assert.match(detail.warning, /降级/);
    assert.equal(detail.score.items.length, RUBRICS.length);
    assert.ok(detail.summary.headline.length > 0, '降级后仍要有可读的结论文案');
  } finally {
    mockMode = 'happy';
  }
});

// ---------------------------------------------------------------------------
// 红线：曾经因为"否定式条件 + 模型答 missing"把好简历全部判红，这里走完整 HTTP 链路回归
// ---------------------------------------------------------------------------

async function screenOne(jd, prefix = '01') {
  const files = (await api('/api/samples')).body.samples.map((s) => s.name);
  const target = files.find((f) => f.startsWith(prefix));
  const started = await api('/api/screen', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jd, samples: [target] }),
  });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const run = await waitRun(started.body.runId);
  const cand = run.candidates[0];
  assert.equal(cand.status, 'done', JSON.stringify(cand));
  return (await api(`/api/candidate/${cand.id}`)).body;
}

test('红线：模型对否定式条件答 missing 时不能判成命中（曾经的"全员变红"）', { timeout: 60000 }, async () => {
  const jd = {
    role: 'AI 自动化实习生',
    rubrics: [
      { id: 'must_major', group: 'must', label: '计算机相关专业', weight: 9, type: 'education', probe: '专业' },
      { id: 'redline_short', group: 'redline', label: '只能实习少于 3 个月', weight: 0, type: 'availability', probe: '实习时长' },
    ],
  };
  const detail = await screenOne(jd);
  const red = detail.score.items.find((i) => i.id === 'redline_short');
  assert.equal(red.verdict, 'missing', '模型对坏条件确实答 missing');
  assert.equal(red.polarity, 'negative', '否定式表述应被识别');
  assert.equal(detail.score.redlineHits.length, 0, '否定式条件不成立 ≠ 命中红线');
  assert.equal(detail.score.decision.code, 'review');
  assert.ok(!/触发红线/.test(detail.score.decision.reason || ''));
});

test('红线：正向条件被判 missing 时确实一票否决', { timeout: 60000 }, async () => {
  const jd = {
    role: 'AI 自动化实习生',
    rubrics: [
      { id: 'must_major', group: 'must', label: '计算机相关专业', weight: 9, type: 'education', probe: '专业' },
      { id: 'redline_intern', group: 'redline', label: '能连续实习至少 3 个月', weight: 0, type: 'availability', probe: '实习时长' },
    ],
  };
  const detail = await screenOne(jd);
  const red = detail.score.items.find((i) => i.id === 'redline_intern');
  assert.equal(red.polarity, 'positive');
  assert.equal(detail.score.redlineHits.length, 1);
  assert.equal(detail.score.decision.code, 'reject');
  assert.match(detail.score.decision.reason, /触发红线/);
});
