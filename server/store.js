import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/** 内存存储 + 单文件 JSON 落盘。演示场景够用，换数据库时只需替换本模块。 */

const runs = new Map();
const candidates = new Map(); // candidateId -> { runId, candidate }
let persistTimer = null;

const rid = (prefix) =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export function createRun({ jdText, role, summary, rubrics, mode, warning, softSkipped }) {
  const run = {
    id: rid('run'),
    createdAt: new Date().toISOString(),
    jdText,
    role,
    summary,
    rubrics,
    mode,
    warning: warning || '',
    softSkipped: softSkipped || [],
    status: 'running',
    candidates: [],
    finishedAt: null,
  };
  runs.set(run.id, run);
  schedulePersist();
  return run;
}

export function getRun(id) {
  return runs.get(id) || null;
}

export function listRuns() {
  return [...runs.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function addCandidate(runId, candidate) {
  const run = runs.get(runId);
  if (!run) throw new Error(`run 不存在：${runId}`);
  run.candidates.push(candidate);
  candidates.set(candidate.id, { runId, candidate });
  schedulePersist();
  return candidate;
}

export function patchCandidate(id, patch) {
  const entry = candidates.get(id);
  if (!entry) return null;
  Object.assign(entry.candidate, patch);
  schedulePersist();
  return entry.candidate;
}

export function getCandidate(id) {
  const entry = candidates.get(id);
  if (!entry) return null;
  const run = runs.get(entry.runId);
  return { run, candidate: entry.candidate };
}

export function refreshRunStatus(runId) {
  const run = runs.get(runId);
  if (!run) return null;
  const pending = run.candidates.some((c) => c.status === 'queued' || c.status === 'parsing' || c.status === 'analyzing');
  run.status = pending ? 'running' : 'done';
  if (!pending && !run.finishedAt) run.finishedAt = new Date().toISOString();
  schedulePersist();
  return run;
}

export function runView(run) {
  if (!run) return null;
  const processing = run.candidates.filter((c) => ['queued', 'parsing', 'analyzing'].includes(c.status)).length;
  return {
    id: run.id,
    role: run.role,
    summary: run.summary,
    rubrics: run.rubrics,
    mode: run.mode,
    warning: run.warning,
    softSkipped: run.softSkipped,
    status: run.status,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
    total: run.candidates.length,
    done: run.candidates.filter((c) => ['done', 'failed', 'unparsed'].includes(c.status)).length,
    processing,
    candidates: run.candidates.map(candidateView).sort((a, b) => (b.score?.confirmedPct ?? -1) - (a.score?.confirmedPct ?? -1)),
  };
}

export function candidateView(c) {
  return {
    id: c.id,
    fileName: c.fileName,
    status: c.status,
    mode: c.mode,
    degraded: c.degraded,
    // 降级原因要说出来：模型超时 / JSON 坏了 / 额度不足，处理方式完全不同
    warning: c.warning || '',
    name:
      c.profile?.name ||
      (c.status === 'unparsed' || c.status === 'failed' ? c.fileName.replace(/\.[^.]+$/, '') : '解析中…'),
    headline: c.summary?.headline || '',
    decision: c.score?.decision || null,
    confirmedPct: c.score?.confirmedPct ?? null,
    coveragePct: c.score?.coveragePct ?? null,
    stats: c.score?.stats || null,
    mustMissing: (c.score?.mustMissing || []).map((i) => i.label),
    evidenceVerifiedRatio: c.meta?.evidenceVerifiedRatio ?? null,
    skills: c.profile?.skills || [],
    elapsedMs: c.meta?.elapsedMs ?? null,
    error: c.error || null,
  };
}

function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try {
      fs.mkdirSync(config.dataDir, { recursive: true });
      const payload = listRuns().map(runView);
      fs.writeFileSync(path.join(config.dataDir, 'runs.json'), JSON.stringify(payload, null, 2), 'utf8');
    } catch (err) {
      console.warn('[store] 落盘失败：', err.message);
    }
  }, 400);
  persistTimer.unref?.();
}

export function bulkAddCandidates(runId, list) {
  for (const c of list) addCandidate(runId, c);
}
