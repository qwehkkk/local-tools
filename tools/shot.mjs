/**
 * 界面截图：分别拍「脱敏（占位符模式 + 映射表展开）」与「还原」两个状态。
 * 用法：node tools/shot.mjs [--w=1280] [--h=1300]
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9336;
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=?(.*)$/);
    return m ? [m[1], m[2] || 'true'] : [a, 'true'];
  })
);
const W = Number(args.w || 1280);
const H = Number(args.h || 1300);
const URL_ = args.url || 'http://127.0.0.1:5180/tools/pii-mask/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEV = join(process.cwd(), '..', '.dev');
mkdirSync(join(DEV, 'shots'), { recursive: true });

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${join(DEV, 'chrome-profile')}`,
    `--window-size=${Math.max(W, 520)},${H}`,
    '--hide-scrollbars',
    '--no-first-run',
    URL_,
  ],
  { stdio: 'ignore' }
);

let wsUrl = null;
for (let i = 0; i < 60; i++) {
  await sleep(300);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    const page = list.find((t) => t.type === 'page' && t.url.includes('pii-mask'));
    if (page?.webSocketDebuggerUrl) {
      wsUrl = page.webSocketDebuggerUrl;
      break;
    }
  } catch {}
}

const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
const send = (method, params = {}) => {
  const i = ++id;
  ws.send(JSON.stringify({ id: i, method, params }));
  return new Promise((r) => pending.set(i, r));
};
const evalJS = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  return r.result?.result?.value;
};

await sleep(900);
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await sleep(300);

// 示例 + 占位符模式 + 展开映射表
await evalJS(`document.getElementById('sampleBtn').click()`);
await sleep(300);
await evalJS(`document.querySelector('#modeSeg button[data-mode="token"]').click()`);
await sleep(400);
await evalJS(`document.getElementById('mapBox').open = true`);
await sleep(400);

const shot1 = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
if (shot1.result?.data) writeFileSync(join(DEV, 'shots', 'ui-mask.png'), Buffer.from(shot1.result.data, 'base64'));

// 还原页签
await evalJS(`document.querySelector('#tabs button[data-tab="restore"]').click()`);
await sleep(800);
const shot2 = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
if (shot2.result?.data) writeFileSync(join(DEV, 'shots', 'ui-restore.png'), Buffer.from(shot2.result.data, 'base64'));

console.log('已截图：ui-mask.png / ui-restore.png');

ws.close();
chrome.kill();
process.exit(0);
