import { llmAvailable } from '../config.js';
import { chatJSON } from '../llm/provider.js';
import { jdRubricPrompt } from '../llm/prompts.js';
import { ensureSchoolRubric, normalizeRubrics, ruleRubricsFromJD } from '../scoring/rules.js';

export class BadRequest extends Error {
  constructor(message, hint = '') {
    super(message);
    this.name = 'BadRequest';
    this.status = 422;
    this.hint = hint;
  }
}

function guessRole(jdText) {
  const patterns = [
    /([\u4e00-\u9fa5A-Za-z·\s]{2,24}(?:实习生|实习|工程师|专员|助理|经理|设计师|运营|顾问|专员助理))/,
    /岗位[:：]\s*([^\n]{2,24})/,
  ];
  for (const re of patterns) {
    const m = jdText.match(re);
    if (m) return m[1].replace(/\s+/g, ' ').trim().slice(0, 24);
  }
  const first = jdText.split('\n').map((l) => l.trim()).find(Boolean) || '';
  return first.slice(0, 24) || '未命名岗位';
}

/**
 * JD → rubric 评分表。
 * 有 Key 走模型拆解；模型不可用/输出不合格时降级到规则引擎（条件模板库）。
 */
export async function decomposeJD(jdText) {
  const text = String(jdText || '').trim();
  if (text.length < 20) {
    throw new BadRequest('JD 内容太短（少于 20 字），无法拆解评估项', '粘贴完整的岗位职责与任职要求');
  }

  let warning = '';
  if (llmAvailable()) {
    try {
      const { data, usage } = await chatJSON(jdRubricPrompt(text));
      const rubrics = normalizeRubrics(ensureSchoolRubric(data?.rubrics));
      const scored = rubrics.filter((r) => r.group !== 'redline');
      if (scored.length < 3) throw new Error(`模型只拆出 ${scored.length} 条有效评估项`);
      return {
        role: String(data?.role || guessRole(text)).slice(0, 40),
        summary: String(data?.summary || '').slice(0, 120),
        rubrics,
        mode: 'llm',
        warning,
        usage,
      };
    } catch (err) {
      warning = `模型拆解不可用（${err.message.slice(0, 60)}），已切换规则引擎`;
      console.warn('[jd]', warning);
    }
  }

  const { rubrics, softSkipped } = ruleRubricsFromJD(text);
  return {
    role: guessRole(text),
    summary: '规则引擎按条件模板库拆解：学历 / 专业 / 编程基础 / 可实习时长 + 方向加分项。',
    rubrics,
    mode: 'rule',
    warning: warning || (llmAvailable() ? '' : '当前为规则模式（未配置 OPENAI_API_KEY），结果由条件模板库给出'),
    softSkipped,
  };
}
