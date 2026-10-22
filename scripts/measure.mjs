// 开发辅助：用 CDP 量关键元素的真实几何，避免靠肉眼判断布局。
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9334;
const URL = process.env.DEMO_URL || 'http://127.0.0.1:5178/';

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--user-data-dir=' + process.env.TEMP + '/dsh-measure',
  '--window-size=1584,885', '--hide-scrollbars', '--no-first-run', 'about:blank',
], { stdio: 'ignore' });

let ws, id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const sid = ++id;
  pending.set(sid, { res, rej });
  ws.send(JSON.stringify({ id: sid, method, params }));
});

try {
  let targets;
  for (let i = 0; i < 40; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      if (targets.length) break;
    } catch {}
    await sleep(250);
  }
  const page = targets.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id).res(msg.result);
      pending.delete(msg.id);
    }
  };
  await send('Page.enable');
  await send('Page.navigate', { url: URL });
  await sleep(1200);

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result?.value;
  };

  const probe = `(() => {
    const box = (sel) => {
      const n = document.querySelector(sel);
      if (!n) return null;
      const r = n.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    };
    return {
      panelHidden: document.querySelector('#rubricPanel').className,
      jd: box('#jdInput'),
      jdStyle: getComputedStyle(document.querySelector('#jdInput')).height,
      hasSupport: CSS.supports('selector(:has(*))'),
      actions: box('.jd-actions'),
      panel: box('#rubricPanel'),
      candList: box('#candList'),
      emptyList: box('#emptyList'),
      colJd: box('.col-jd'),
      colJdScroll: (() => { const n = document.querySelector('.col-jd'); return { sh: n.scrollHeight, ch: n.clientHeight }; })(),
    };
  })()`;

  console.log('空态：', JSON.stringify(await evaluate(probe), null, 1));

  await evaluate(`document.querySelector('#btnSampleJD').click()`);
  await sleep(300);
  await evaluate(`document.querySelector('#btnParseJD').click()`);
  await sleep(2500);
  console.log('拆解后：', JSON.stringify(await evaluate(probe), null, 1));
} finally {
  try { ws?.close(); } catch {}
  chrome.kill();
}
