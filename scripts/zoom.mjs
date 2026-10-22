// 开发辅助：放大截取某块区域，用来确认细节是否真的重叠/对齐。
// 用法：node scripts/zoom.mjs <x> <y> <w> <h> <out.png>
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';

const [x, y, w, h, out = 'shots/zoom.png'] = process.argv.slice(2);
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9335;
const URL = process.env.DEMO_URL || 'http://127.0.0.1:5178/';

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--user-data-dir=' + process.env.TEMP + '/dsh-zoom',
  '--window-size=1584,885', '--hide-scrollbars', '--no-first-run', 'about:blank',
], { stdio: 'ignore' });

let ws, id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((res) => {
  const sid = ++id;
  pending.set(sid, res);
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
  ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
  };
  await send('Page.enable');
  await send('Page.navigate', { url: URL });
  await sleep(1400);
  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: Number(x), y: Number(y), width: Number(w), height: Number(h), scale: 2 },
  });
  fs.mkdirSync('shots', { recursive: true });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('已保存', out);
} finally {
  try { ws?.close(); } catch {}
  chrome.kill();
}
