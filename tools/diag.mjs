/**
 * 布局诊断：找出所有横向溢出视口的元素
 * 用法：node tools/diag.mjs [--url=...] [--w=390] [--h=760]
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9335;
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    // [\s\S] 而不是 .，否则带换行的 --js 参数会解析失败
    const m = a.match(/^--([^=]+)=?([\s\S]*)$/);
    return m ? [m[1], m[2] || 'true'] : [a, 'true'];
  })
);
const URL_ = args.url || 'http://127.0.0.1:5180/tools/pii-mask/';
const W = Number(args.w || 390);
const H = Number(args.h || 760);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = join(process.cwd(), '..', '.dev', 'chrome-profile');
mkdirSync(profile, { recursive: true });

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    `--window-size=${W},${H}`,
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
    const page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools'));
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

await sleep(800);

// --files 可以先上传文件，否则量测的是空列表（.pdfrow 之类根本不存在）
if (args.files) {
  await send('DOM.enable');
  const doc = await send('DOM.getDocument', { depth: -1 });
  const q = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#files' });
  if (!q.result?.nodeId) {
    console.error('页面里没有 #files 输入框，跳过 --files');
  } else {
    const files = args.files.split(',').map((f) => f.trim()).filter(Boolean);
    await send('DOM.setFileInputFiles', { nodeId: q.result.nodeId, files });
    await send('Runtime.evaluate', {
      expression: "document.getElementById('files').dispatchEvent(new Event('change',{bubbles:true}));true",
    });
    await sleep(1800);
  }
}

await send('Emulation.setDeviceMetricsOverride', {
  width: W,
  height: H,
  deviceScaleFactor: 1,
  mobile: false, // 不用 mobile:true，避免移动端 viewport 缩放干扰量测
});
await sleep(400);

// --js 可以临时量任意东西，避免为每次排查再写一个一次性脚本
if (args.js) {
  const r = await send('Runtime.evaluate', {
    expression: args.js,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.result?.exceptionDetails) {
    console.error('执行出错：', r.result.exceptionDetails.exception?.description);
  } else {
    console.log(JSON.stringify(r.result?.result?.value, null, 2));
  }
  ws.close();
  chrome.kill();
  process.exit(0);
}

const r = await send('Runtime.evaluate', {
  expression: `(() => {
    const vw = document.documentElement.clientWidth;
    const out = [];
    document.querySelectorAll('*').forEach(el => {
      const b = el.getBoundingClientRect();
      if (b.right > vw + 1 || b.left < -1) {
        out.push({
          tag: el.tagName.toLowerCase(),
          cls: el.className && typeof el.className === 'string' ? el.className.slice(0, 40) : '',
          left: Math.round(b.left),
          right: Math.round(b.right),
          width: Math.round(b.width),
          text: (el.textContent || '').trim().slice(0, 24),
        });
      }
    });
    return {
      vw,
      scrollWidth: document.documentElement.scrollWidth,
      bodyScroll: document.body.scrollWidth,
      overflow: out.slice(0, 15),
    };
  })()`,
  returnByValue: true,
});

const v = r.result?.result?.value;
console.log('视口宽:', v.vw, ' document.scrollWidth:', v.scrollWidth, ' body.scrollWidth:', v.bodyScroll);
console.log('溢出元素数:', v.overflow.length);
for (const o of v.overflow) {
  console.log(`  <${o.tag} class="${o.cls}"> left=${o.left} right=${o.right} w=${o.width}  text="${o.text}"`);
}

ws.close();
chrome.kill();
process.exit(0);
