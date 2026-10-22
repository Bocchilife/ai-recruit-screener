import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { config, currentMode, ensureDirs } from './config.js';
import { llmStatus } from './llm/provider.js';
import { SAMPLE_JD } from './llm/prompts.js';
import { BadRequest, decomposeJD } from './pipeline/jd.js';
import { makeCandidate, mapLimit, processCandidate } from './pipeline/match.js';
import * as store from './store.js';

ensureDirs();

const app = express();
app.use(express.json({ limit: '4mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxFileBytes, files: 20 },
});

// ---------------------------------------------------------------------------
// 元信息
// ---------------------------------------------------------------------------

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    mode: currentMode(),
    llm: llmStatus(),
    concurrency: config.concurrency,
    samples: listSampleFiles().length,
    maxFileMB: Math.round(config.maxFileBytes / 1024 / 1024),
  });
});

app.get('/api/sample-jd', (req, res) => res.json({ jd: SAMPLE_JD }));

app.get('/api/samples', (req, res) => res.json({ samples: listSampleFiles() }));

function listSampleFiles() {
  try {
    return fs
      .readdirSync(config.samplesDir)
      .filter((f) => /\.(pdf|docx|txt|md)$/i.test(f))
      .sort()
      .map((name) => {
        const stat = fs.statSync(path.join(config.samplesDir, name));
        return { name, size: stat.size, kind: path.extname(name).slice(1).toLowerCase() };
      });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// JD 拆解
// ---------------------------------------------------------------------------

app.post('/api/jd/parse', async (req, res, next) => {
  try {
    const jdText = String(req.body?.jd || req.body?.jdText || '');
    const result = await decomposeJD(jdText);
    res.json({ ...result, jdText });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// 批量筛选
// ---------------------------------------------------------------------------

function readJdPayload(req) {
  let raw = req.body?.jd;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new BadRequest('jd 字段不是合法 JSON');
    }
  }
  if (!raw || !Array.isArray(raw.rubrics) || raw.rubrics.length === 0) {
    throw new BadRequest('缺少评分表（rubrics），请先拆解 JD', '先点「① 拆解岗位要求」');
  }
  return {
    jdText: String(raw.jdText || ''),
    role: String(raw.role || '未命名岗位'),
    summary: String(raw.summary || ''),
    rubrics: raw.rubrics,
    mode: raw.mode || 'unknown',
    warning: String(raw.warning || ''),
    softSkipped: Array.isArray(raw.softSkipped) ? raw.softSkipped : [],
  };
}

// multer 只处理 multipart；对 JSON 请求直接放行。
// 否则 multer 会把已解析好的 req.body 重置成空对象，JD 就"丢"了。
const uploadFiles = (req, res, next) =>
  (req.headers['content-type'] || '').includes('multipart/form-data')
    ? upload.array('files', 20)(req, res, next)
    : next();

app.post('/api/screen', uploadFiles, async (req, res, next) => {
  try {
    const jd = readJdPayload(req);
    let files = (req.files || []).map((f) => ({
      originalname: Buffer.from(f.originalname, 'latin1').toString('utf8'),
      size: f.size,
      buffer: f.buffer,
    }));

    // 支持直接使用服务端内置样例（不必前端下载再上传）
    if (files.length === 0 && Array.isArray(req.body?.samples)) {
      files = req.body.samples.map((item) => {
        // 同时接受 "文件名" 和 /api/samples 返回的 { name, size, kind }
        const safe = path.basename(String(typeof item === 'string' ? item : item?.name || ''));
        if (!/\.(pdf|docx|txt|md)$/i.test(safe)) throw new BadRequest(`样例文件类型不支持：${safe}`);
        const p = path.join(config.samplesDir, safe);
        if (!fs.existsSync(p)) throw new BadRequest(`样例文件不存在：${safe}`);
        const buffer = fs.readFileSync(p);
        return { originalname: safe, size: buffer.length, buffer };
      });
    }

    if (files.length === 0) throw new BadRequest('没有收到简历文件');
    if (files.length > 20) throw new BadRequest('单次最多 20 份简历');

    const run = store.createRun(jd);
    const candidates = files.map((f) => makeCandidate(run.id, f));
    store.bulkAddCandidates(run.id, candidates);

    // 后台并发处理，前端轮询进度（不用 SSE：少一个现场故障点）
    (async () => {
      try {
        await mapLimit(
          candidates.map((c, i) => ({ candidate: c, file: files[i] })),
          config.concurrency,
          async ({ candidate, file }) => {
            try {
              await processCandidate({ candidate, jd, buffer: file.buffer });
            } catch (err) {
              console.error(`[screen] ${file.originalname} 处理失败：`, err);
              store.patchCandidate(candidate.id, {
                status: 'failed',
                error: { code: 'INTERNAL', message: err.message, hint: '' },
                meta: { elapsedMs: 0 },
              });
            }
          },
        );
      } finally {
        store.refreshRunStatus(run.id);
      }
    })();

    res.status(202).json({ runId: run.id, total: candidates.length, mode: currentMode() });
  } catch (err) {
    next(err);
  }
});

app.get('/api/run/:id', (req, res) => {
  const run = store.getRun(req.params.id);
  if (!run) return res.status(404).json({ error: '未找到该批次' });
  res.json(store.runView(store.refreshRunStatus(run.id)));
});

app.get('/api/candidate/:id', (req, res) => {
  const found = store.getCandidate(req.params.id);
  if (!found) return res.status(404).json({ error: '未找到该候选人' });
  res.json({ ...found.candidate, runRubrics: found.run?.rubrics || [], role: found.run?.role || '' });
});

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

app.get('/api/export/:id.csv', (req, res) => {
  const run = store.getRun(req.params.id);
  if (!run) return res.status(404).json({ error: '未找到该批次' });
  const view = store.runView(store.refreshRunStatus(run.id));
  const head = ['文件名', '姓名', '结论', '已确认匹配度%', '信息覆盖率%', '硬性要求缺口', '待确认项', '一句话结论', '模式', '耗时ms'];
  const rows = view.candidates.map((c) => [
    c.fileName,
    c.name,
    c.decision?.label || '',
    c.confirmedPct ?? '',
    c.coveragePct ?? '',
    (c.mustMissing || []).join('; '),
    c.stats?.unknown ?? '',
    c.headline,
    c.mode === 'llm' ? 'LLM' : '规则',
    c.elapsedMs ?? '',
  ]);
  const csv = [head, ...rows]
    .map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\r\n');
  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', `attachment; filename="screening-${run.id}.csv"`);
  res.send('\ufeff' + csv);
});

// ---------------------------------------------------------------------------
// 静态资源与错误处理
// ---------------------------------------------------------------------------

app.use(express.static(path.join(config.root, 'public'), { extensions: ['html'] }));

app.use((err, req, res, next) => {
  if (err instanceof BadRequest) {
    return res.status(err.status || 422).json({ error: err.message, hint: err.hint });
  }
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `单个文件超过 ${Math.round(config.maxFileBytes / 1024 / 1024)}MB 限制` });
  }
  if (err?.code === 'LIMIT_FILE_COUNT') {
    return res.status(413).json({ error: '单次最多 20 份简历' });
  }
  console.error('[server] 未处理错误：', err);
  res.status(500).json({ error: err.message || '服务内部错误' });
});

const server = app.listen(config.port, () => {
  const isLLM = currentMode() === 'llm';
  console.log(`\n  AI 简历筛选助手已启动 → http://localhost:${config.port}`);
  console.log(`  模式：${isLLM ? `LLM（${config.llm.model}）` : '规则引擎（未配置 Key，可正常演示）'}`);
  console.log(`  并发：${config.concurrency}   样例简历：${listSampleFiles().length} 份\n`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && !process.env.PORT) {
    console.warn(`端口 ${config.port} 被占用，尝试 ${config.port + 1} …`);
    app.listen(config.port + 1, () => console.log(`\n  已启动 → http://localhost:${config.port + 1}\n`));
  } else {
    console.error('启动失败：', err.message);
    process.exit(1);
  }
});
