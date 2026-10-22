import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

// 读取 .env（存在则加载，不覆盖已有环境变量）
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile);
  } catch (err) {
    console.warn('[config] .env 读取失败：', err.message);
  }
}

const num = (v, d) => (Number.isFinite(Number(v)) && String(v).trim() !== '' ? Number(v) : d);

export const config = {
  root: ROOT,
  port: num(process.env.PORT, 5178),
  // DATA_DIR 可指向临时目录，测试时用来隔离持久化文件
  dataDir: path.resolve(ROOT, process.env.DATA_DIR || 'data'),
  uploadsDir: path.resolve(ROOT, process.env.DATA_DIR || 'data', 'uploads'),
  samplesDir: path.join(ROOT, 'samples'),
  maxFileBytes: num(process.env.MAX_FILE_MB, 8) * 1024 * 1024,
  concurrency: num(process.env.SCREEN_CONCURRENCY, 3),
  llm: {
    baseUrl: (process.env.OPENAI_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'deepseek-chat',
    timeoutMs: num(process.env.LLM_TIMEOUT_MS, 60000),
    retries: num(process.env.LLM_RETRIES, 2),
    temperature: num(process.env.LLM_TEMPERATURE, 0.1),
  },
  // DEMO_FORCE_RULE=1 可强制走规则引擎，用于演示"模型不可用"的降级路径
  forceRule: /^(1|true|yes)$/i.test(process.env.DEMO_FORCE_RULE || ''),
};

export const llmAvailable = () => Boolean(config.llm.apiKey) && !config.forceRule;

export const currentMode = () => (llmAvailable() ? 'llm' : 'rule');

export function ensureDirs() {
  for (const dir of [config.dataDir, config.uploadsDir, config.samplesDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
