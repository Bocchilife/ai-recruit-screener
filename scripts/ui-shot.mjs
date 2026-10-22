/**
 * 界面截图脚本（开发/文档用，不参与 Demo 运行）
 * 用 Chrome DevTools Protocol 驱动 headless Chrome 走一遍主流程并逐步截图，
 * 顺便把页面里的 JS 报错抓回来。用法：node scripts/ui-shot.mjs [输出目录]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));
const URL_BASE = process.env.DEMO_URL || 'http://127.0.0.1:5178/';
const OUT = path.resolve(process.argv[2] || 'shots');
const PORT = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(OUT, { recursive: true });

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-shot-'));
const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--no-first-run',
  '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--window-size=1600,980',
  'about:blank',
], { stdio: 'ignore' });

let ws;
let seq = 0;
const pending = new Map();
const logs = [];

function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`CDP 超时：${method}`));
      }
    }, 20000);
  });
}

async function evaluate(expression) {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (res.exceptionDetails) throw new Error(`页面 JS 抛错：${res.exceptionDetails.text} ${res.exceptionDetails.exception?.description || ''}`);
  return res.result?.value;
}

async function waitFor(expression, timeout = 25000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await evaluate(`(() => { try { return Boolean(${expression}); } catch (e) { return false; } })()`)) return true;
    await sleep(200);
  }
  throw new Error(`等待超时：${expression}`);
}

async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`  · 截图 ${path.relative(process.cwd(), file)}`);
}

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
      const page = targets.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  throw new Error('Chrome 调试端口没起来');
}

async function main() {
  ws = new WebSocket(await connect());
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
      logs.push(`console.${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      logs.push(`uncaught: ${msg.params.exceptionDetails.text} ${msg.params.exceptionDetails.exception?.description || ''}`);
    }
  });
  await new Promise((r) => ws.addEventListener('open', r));
  await send('Runtime.enable');
  await send('Page.enable');

  console.log('打开页面…');
  await send('Page.navigate', { url: URL_BASE });
  await sleep(1200);

  const health = await evaluate(`fetch('/api/health').then(r => r.json())`);
  console.log(`  模式：${health.llm?.mode || health.mode} · 模型：${health.llm?.model || '(规则引擎)'}`);
  console.log(`  顶栏徽标：${await evaluate(`document.querySelector('#modeBadge').textContent`)}`);

  await shot('01-empty');

  // 走主流程：填 JD → 拆解 → 跑样例 → 点开第一位
  await evaluate(`document.querySelector('#btnSampleJD').click(); true`);
  await sleep(400);
  await evaluate(`document.querySelector('#btnParseJD').click(); true`);
  await waitFor(`!document.querySelector('#rubricPanel').classList.contains('hidden')`);
  await sleep(300);
  await shot('02-rubrics');

  await evaluate(`document.querySelector('#btnSamples').click(); true`);
  await waitFor(`document.querySelectorAll('#candList .cand').length >= 10`, 40000);
  await waitFor(`document.querySelector('#runBar').classList.contains('hidden')`, 40000);
  await sleep(600);
  await shot('03-list');

  const rows = await evaluate(`document.querySelectorAll('#candList .cand').length`);
  console.log(`  候选人行数：${rows}`);

  // 再导入一份新简历：验证"不清空已导入的列表"
  const extraDir = path.join(OUT, '.tmp');
  fs.mkdirSync(extraDir, { recursive: true });
  const sampleTxt = fs
    .readdirSync(path.resolve('samples'))
    .filter((f) => f.endsWith('.txt'))
    .sort()[0];
  const extra = path.join(extraDir, '11-新导入候选人.txt');
  fs.copyFileSync(path.resolve('samples', sampleTxt), extra);
  await send('DOM.enable');
  const { root } = await send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '#fileInput' });
  await send('DOM.setFileInputFiles', { files: [extra], nodeId });
  await waitFor(`document.querySelectorAll('#candList .cand').length > ${rows}`, 40000);
  await sleep(500);
  const rowsAfter = await evaluate(`document.querySelectorAll('#candList .cand').length`);
  console.log(`  再导入一份后行数：${rowsAfter}（${rowsAfter > rows ? '前面的结果没有被清空 ✓' : '被清空了 ✗'}）`);
  await shot('07-appended');

  await evaluate(`document.querySelectorAll('#candList .cand')[0].click(); true`);
  await waitFor(`document.querySelectorAll('.verdict-item').length > 0`);
  await sleep(500);
  await shot('04-detail');

  // 详情栏的下半截：追问清单 + 触达话术
  await evaluate(`(() => { const n = document.querySelector('.col-detail'); n.scrollTop = n.scrollHeight; return true; })()`);
  await sleep(500);
  await shot('05-detail-bottom');

  // 换一位"信息不足"的候选人，确认四态与追问的呈现
  await evaluate(`(() => { const rows = [...document.querySelectorAll('#candList .cand')]; const t = rows.find(r => /信息不足/.test(r.textContent)); if (t) t.click(); return true; })()`);
  await sleep(700);
  await shot('06-unknown');

  // 院校层次细分加权是否可见（211/双一流 的项目会显示 ×0.75 / ×0.5）
  const tier = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('#candList .cand')];
    const box = [...document.querySelectorAll('.verdict-item')];
    const row = rows.find(r => /南京理工|合肥工业|深圳大学/.test(r.textContent)) || rows[0];
    row?.click();
    return true;
  })()`);
  await sleep(900);
  const factorChips = await evaluate(`[...document.querySelectorAll('.verdict-item')].map(n => n.textContent.replace(/\\s+/g, ' ')).filter(t => /重点院校/.test(t))`);
  console.log(`  院校加分项呈现：${JSON.stringify(factorChips).slice(0, 240)}`);
  await shot('08-school-tier');

  // 几何自检：关键区块是否重叠 / 溢出
  const geom = await evaluate(`(() => {
    const r = (sel) => { const n = document.querySelector(sel); if (!n) return null; const b = n.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
    return {
      jd: r('#jdInput'), actions: r('.jd-actions'), panel: r('#rubricPanel'),
      list: r('#candList'), detail: r('#detail'), drop: r('#dropzone'),
      scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth,
      rowOverflow: [...document.querySelectorAll('.cand')].some(n => n.scrollWidth > n.clientWidth + 1),
    };
  })()`);
  console.log('  几何：', JSON.stringify(geom));

  if (logs.length) {
    console.log('\n页面报错 / 警告：');
    for (const line of [...new Set(logs)]) console.log('  !', line);
  } else {
    console.log('\n无页面 JS 报错');
  }
}

main()
  .catch((err) => {
    console.error('截图失败：', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { ws?.close(); } catch { /* ignore */ }
    await sleep(150);
    chrome.kill();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  });
