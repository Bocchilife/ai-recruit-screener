import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5199;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = 'data/.test-run';

let server;
let stderr = '';

async function api(pathname, options) {
  const res = await fetch(BASE + pathname, options);
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  return { status: res.status, body: isJson ? await res.json() : await res.text() };
}

before(async () => {
  fs.rmSync(path.join(ROOT, DATA_DIR), { recursive: true, force: true });
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    // 测试用独立数据目录 + 强制规则模式，不碰真实数据、不发网络请求
    env: { ...process.env, PORT: String(PORT), DATA_DIR, OPENAI_API_KEY: '', DEMO_FORCE_RULE: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr.on('data', (b) => (stderr += b.toString()));

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const { body } = await api('/api/health');
      if (body.ok) return;
    } catch {
      /* 还没监听 */
    }
    await sleep(150);
  }
  throw new Error(`服务没起来：${stderr}`);
});

after(async () => {
  server?.kill();
  await sleep(400);
  fs.rmSync(path.join(ROOT, DATA_DIR), { recursive: true, force: true });
});

test('端到端：拆 JD → 跑 10 份样例 → 拿判定与证据 → 导出 CSV', { timeout: 90000 }, async () => {
  const health = (await api('/api/health')).body;
  assert.equal(health.mode, 'rule');
  assert.equal(health.samples, 10);

  // 1) 内置示例 JD
  const sample = (await api('/api/sample-jd')).body;
  assert.ok(sample.jd.length > 100);

  // 2) JD 拆解成可判定的评估项
  const parsedRes = await api('/api/jd/parse', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jd: sample.jd }),
  });
  assert.equal(parsedRes.status, 200, stderr);
  const parsed = parsedRes.body;
  assert.ok(parsed.rubrics.length >= 3);
  assert.ok(parsed.rubrics.every((r) => r.label && ['must', 'nice', 'redline'].includes(r.group)));
  assert.ok(parsed.rubrics.some((r) => r.group === 'must'));

  // 3) 用服务端样例简历跑一整批
  const files = (await api('/api/samples')).body.samples.map((s) => s.name);
  assert.equal(files.length, 10);

  const started = await api('/api/screen', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jd: parsed, samples: files }),
  });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  assert.equal(started.body.total, 10);

  let run;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    run = (await api(`/api/run/${started.body.runId}`)).body;
    if (run.status === 'done') break;
    await sleep(300);
  }
  assert.equal(run.status, 'done');
  assert.equal(run.candidates.length, 10);

  // 4) 读不出的简历要单独标出，而不是静默丢弃或算成 0 分
  const failed = run.candidates.filter((c) => c.status === 'unparsed');
  assert.equal(failed.length, 1);
  assert.match(failed[0].fileName, /扫描件/);
  assert.equal(failed[0].error.code, 'SCANNED_PDF');

  const done = run.candidates.filter((c) => c.status === 'done');
  assert.equal(done.length, 9);
  // 结论必须有区分度：不能全员同一种结论
  assert.ok(new Set(done.map((c) => c.decision.code)).size >= 3);

  // 5) 详情：判定条数对齐评分表，证据可回溯，缺口有追问
  const reviewed = done.find((c) => c.decision.code === 'review');
  assert.ok(reviewed, '样例里应至少有一位可进入复核');
  const detail = (await api(`/api/candidate/${reviewed.id}`)).body;
  assert.equal(detail.score.items.length, parsed.rubrics.length);
  assert.ok(detail.score.decision.reason.length > 0);
  assert.ok(detail.summary.questions.length > 0);
  assert.ok(detail.score.items.every((i) => ['met', 'partial', 'missing', 'unknown'].includes(i.verdict)));
  const evidence = detail.score.items.flatMap((i) => i.evidence || []);
  assert.ok(evidence.length > 0);
  assert.ok(evidence.every((e) => e.quote && typeof e.verified === 'boolean'));

  // 信息不足的简历要能被识别成"没法判断"，而不是判成"不满足"
  const thin = done.find((c) => c.decision.code === 'insufficient');
  assert.ok(thin, '应有信息过少、无法判断的简历');
  const thinDetail = (await api(`/api/candidate/${thin.id}`)).body;
  assert.ok(thinDetail.score.coveragePct < 50);
  assert.ok(thinDetail.score.items.some((i) => i.verdict === 'unknown'));

  // 6) CSV 导出：带 BOM（Excel 打开不乱码）
  const csvRes = await fetch(`${BASE}/api/export/${started.body.runId}.csv`);
  assert.equal(csvRes.status, 200);
  assert.match(csvRes.headers.get('content-type') || '', /csv/);
  const bytes = Buffer.from(await csvRes.arrayBuffer());
  // fetch().text() 会吞掉 BOM，所以要看原始字节
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const csvText = bytes.subarray(3).toString('utf8');
  assert.match(csvText, /文件名/);
  assert.match(csvText, /建议进入人工复核/);
});

test('错误输入给出可读的 4xx，而不是 500', { timeout: 30000 }, async () => {
  const shortJd = await api('/api/jd/parse', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jd: '招实习生' }),
  });
  assert.equal(shortJd.status, 422);
  assert.match(shortJd.body.error, /JD/);

  const noRubrics = await api('/api/screen', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jd: { rubrics: [] }, samples: [] }),
  });
  assert.equal(noRubrics.status, 422);
  assert.match(noRubrics.body.error, /评分表|简历/);

  const missingRun = await api('/api/run/run_not_exist');
  assert.equal(missingRun.status, 404);

  const badSample = await api('/api/screen', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jd: { rubrics: [{ id: 'a', group: 'must', label: 'x', weight: 5 }] }, samples: ['../package.json'] }),
  });
  assert.equal(badSample.status, 422);
});
