import { llmAvailable } from '../config.js';
import { chatJSON } from '../llm/provider.js';
import { analyzePrompt, summaryPrompt } from '../llm/prompts.js';
import { parseResumeBuffer } from './resume-parse.js';
import {
  buildQuestions,
  ruleProfile,
  ruleSummary,
  ruleVerdictFor,
  ruleVerdicts,
  scoreCandidate,
  verifyEvidence,
} from '../scoring/rules.js';
import * as store from '../store.js';

const newId = () => `cand_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export function makeCandidate(runId, file) {
  return {
    id: newId(),
    runId,
    fileName: file.originalname,
    sizeBytes: file.size,
    status: 'queued',
    mode: llmAvailable() ? 'llm' : 'rule',
    degraded: false,
    profile: null,
    parse: null,
    score: null,
    summary: null,
    meta: {},
    error: null,
  };
}

/** 并发受限的 map */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return results;
}

const isEmpty = (v) =>
  v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0) ||
  (typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(isEmpty));

/** 模型抽取为空时用规则抽取兜底填字段（只填空，不覆盖） */
export function mergeProfile(primary, fallback) {
  const out = structuredClone(primary || {});
  const walk = (target, source, keyParent = '') => {
    for (const [k, v] of Object.entries(source || {})) {
      const cur = target[k];
      if (cur && typeof cur === 'object' && !Array.isArray(cur) && v && typeof v === 'object' && !Array.isArray(v)) {
        walk(cur, v, k);
      } else if (isEmpty(cur) && !isEmpty(v)) {
        target[k] = v;
      }
    }
    return target;
  };
  walk(out, fallback);
  return out;
}

function withEvidenceCheck(score, rawText) {
  let verified = 0;
  let total = 0;
  const items = score.items.map((item) => {
    const check = verifyEvidence(item.evidenceRaw, rawText);
    verified += check.evidence.filter((e) => e.verified).length;
    total += check.evidence.length;
    return { ...item, evidence: check.evidence, evidenceOk: check.allVerified };
  });
  return {
    score: { ...score, items },
    evidenceVerifiedRatio: total > 0 ? verified / total : null,
  };
}

/**
 * 单份简历全流程：解析 → 抽取+判定 → 打分 → 结论文案。
 * 任一 LLM 环节失败都降级到规则引擎，不中断整批。
 */
export async function processCandidate({ candidate, jd, buffer }) {
  const startedAt = Date.now();
  store.patchCandidate(candidate.id, { status: 'parsing' });

  let parsed;
  try {
    parsed = await parseResumeBuffer(buffer, candidate.fileName);
  } catch (err) {
    store.patchCandidate(candidate.id, {
      status: 'unparsed',
      error: { code: err.code || 'PARSE_ERROR', message: err.message, hint: err.hint || '' },
      meta: { elapsedMs: Date.now() - startedAt },
    });
    return;
  }

  store.patchCandidate(candidate.id, {
    status: 'analyzing',
    parse: { chars: parsed.chars, kind: parsed.kind, pages: parsed.pages || null },
  });

  const rawText = parsed.text;
  const fallbackProfile = ruleProfile(rawText);
  let profile = fallbackProfile;
  let verdicts = null;
  let degraded = false;
  let usedLLM = false;
  let warning = '';
  let usage = null;

  if (llmAvailable()) {
    try {
      const { data, usage: u } = await chatJSON(analyzePrompt(jd.rubrics, rawText.slice(0, 12000)));
      const gotVerdicts = Array.isArray(data?.verdicts) ? data.verdicts : null;
      if (!gotVerdicts || gotVerdicts.length === 0) throw new Error('模型未返回有效判定');
      verdicts = gotVerdicts;
      usedLLM = true;
      profile = mergeProfile(data.profile, fallbackProfile);
      usage = usage ? mergeUsage(usage, u) : u;
    } catch (err) {
      degraded = true;
      warning = `模型分析失败已降级规则引擎：${err.message.slice(0, 80)}`;
      console.warn(`[match] ${candidate.fileName}: ${warning}`);
    }
  }

  if (!verdicts) verdicts = ruleVerdicts(jd.rubrics, { rawText, profile });
  if (!profile) profile = fallbackProfile;

  // 院校层次（985 / 211 / 双一流）是公开的确定事实：用规则引擎覆盖模型判定，
  // 避免模型把"中山大学"认成普通本科、或反过来给不存在的院校加分。
  verdicts = overrideSchoolTier(jd.rubrics, verdicts, { rawText, profile });

  const baseScore = scoreCandidate(jd.rubrics, verdicts);
  const { score, evidenceVerifiedRatio } = withEvidenceCheck(baseScore, rawText);

  let summary = ruleSummary({ role: jd.role, profile, score });
  if (llmAvailable() && !degraded) {
    try {
      const { data, usage: u } = await chatJSON(summaryPrompt({ role: jd.role, profile, score }));
      summary = {
        headline: String(data?.headline || summary.headline).slice(0, 60),
        strengths: toList(data?.strengths, summary.strengths),
        risks: toList(data?.risks, summary.risks),
        questions: toList(data?.questions, summary.questions),
        message: String(data?.message || summary.message).slice(0, 300),
      };
      usage = usage ? mergeUsage(usage, u) : u;
    } catch (err) {
      degraded = true;
      warning = `${warning} 结论文案生成失败，使用模板：${err.message.slice(0, 60)}`.trim();
    }
  }

  // 规则生成的追问永远并进来：模型容易漏掉 unknown 项，规则兜底保证不漏。
  summary.questions = [...new Set([...summary.questions, ...buildQuestions(score)])].slice(0, 6);

  store.patchCandidate(candidate.id, {
    status: 'done',
    mode: usedLLM ? 'llm' : 'rule',
    degraded,
    profile,
    score,
    summary,
    warning,
    meta: {
      elapsedMs: Date.now() - startedAt,
      model: llmAvailable() ? undefined : 'rule-engine',
      usage,
      evidenceVerifiedRatio,
      chars: parsed.chars,
    },
  });
  return store.getCandidate(candidate.id)?.candidate;
}

/** 用规则引擎的院校层次判定覆盖模型结果（确定事实不交给模型猜） */
function overrideSchoolTier(rubrics, verdicts, ctx) {
  const list = Array.isArray(rubrics) ? rubrics : [];
  const target = list.find((r) => r?.id === 'nice_school');
  if (!target) return verdicts;
  const rule = ruleVerdictFor(target, ctx);
  const rest = (Array.isArray(verdicts) ? verdicts : []).filter(
    (v) => String(v?.rubric_id || v?.rubricId || v?.id || '') !== target.id,
  );
  return [...rest, rule];
}

function toList(value, fallback) {
  const arr = Array.isArray(value) ? value.map((v) => String(v)).filter(Boolean) : [];
  return arr.length ? arr.slice(0, 6) : fallback;
}

function mergeUsage(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return {
    prompt_tokens: (a.prompt_tokens || 0) + (b.prompt_tokens || 0),
    completion_tokens: (a.completion_tokens || 0) + (b.completion_tokens || 0),
    total_tokens: (a.total_tokens || 0) + (b.total_tokens || 0),
  };
}
