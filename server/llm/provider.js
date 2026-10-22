import { config, llmAvailable } from '../config.js';

export class LLMError extends Error {
  constructor(message, { code = 'LLM_ERROR', cause } = {}) {
    super(message);
    this.name = 'LLMError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 从模型回复里尽力提取 JSON：去掉 ```json 围栏、截取首个 { 到末个 } */
export function extractJSON(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new LLMError('模型返回为空', { code: 'EMPTY_RESPONSE' });
  }
  let body = text.trim();
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) body = fence[1].trim();
  if (body.startsWith('{') || body.startsWith('[')) {
    try {
      return JSON.parse(body);
    } catch {
      /* 落到下面的截取逻辑 */
    }
  }
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const slice = body.slice(start, end + 1);
    try {
      return JSON.parse(slice);
    } catch {
      /* 继续尝试修复尾逗号 */
    }
    try {
      return JSON.parse(slice.replace(/,\s*([}\]])/g, '$1'));
    } catch {
      /* ignore */
    }
  }
  throw new LLMError('模型返回不是合法 JSON', { code: 'BAD_JSON' });
}

async function postOnce({ messages, jsonMode, signal }) {
  const payload = {
    model: config.llm.model,
    messages,
    temperature: config.llm.temperature,
    max_tokens: 2000,
  };
  if (jsonMode) payload.response_format = { type: 'json_object' };

  const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.llm.apiKey}`,
    },
    body: JSON.stringify(payload),
    signal,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const err = new LLMError(`HTTP ${res.status} ${detail.slice(0, 300)}`, {
      code: `HTTP_${res.status}`,
    });
    // 部分服务商不支持 response_format，降级为纯 prompt 约束
    err.retryWithoutJsonMode = jsonMode && (res.status === 400 || res.status === 422);
    throw err;
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content ?? '';
  return { content, usage: data?.usage ?? null };
}

/**
 * 调用 OpenAI 兼容的 chat/completions，返回解析后的 JSON。
 * 失败按 config.llm.retries 重试，最终抛 LLMError 由上层决定是否降级到规则引擎。
 */
export async function chatJSON({ system, user }) {
  if (!llmAvailable()) {
    throw new LLMError('未配置模型（OPENAI_API_KEY 为空或已强制规则模式）', { code: 'NO_KEY' });
  }
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];

  let jsonMode = true;
  let lastErr = null;
  for (let attempt = 0; attempt <= config.llm.retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.llm.timeoutMs);
    try {
      const { content, usage } = await postOnce({ messages, jsonMode, signal: controller.signal });
      return { data: extractJSON(content), usage, raw: content };
    } catch (err) {
      lastErr = err;
      if (err?.retryWithoutJsonMode) {
        jsonMode = false;
        continue; // 立刻重试，不计入退避等待
      }
      if (err?.name === 'AbortError') {
        lastErr = new LLMError(`模型调用超时（>${config.llm.timeoutMs}ms）`, { code: 'TIMEOUT' });
      }
      if (err?.code?.startsWith('HTTP_') && !/^HTTP_5\d\d/.test(err.code) && !/^HTTP_429/.test(err.code)) {
        break; // 4xx（鉴权/额度）重试无意义
      }
      if (attempt < config.llm.retries) await sleep(600 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof LLMError
    ? lastErr
    : new LLMError(lastErr?.message || '模型调用失败', { cause: lastErr });
}

export const llmStatus = () => ({
  mode: llmAvailable() ? 'llm' : 'rule',
  provider: config.llm.baseUrl,
  model: config.llm.model,
  keyPresent: Boolean(config.llm.apiKey),
  forced: config.forceRule,
});
