/**
 * 线上回归：真实 Chrome 打开已发布的站点，走一遍用户路径。
 *
 *   node tools/verify-live.mjs
 *   node tools/verify-live.mjs --url=https://example.com/?sharecode=XXXX
 *
 * 和 verify-*.mjs 的分工：那几个用本地服务测功能，这个只测「线上这一份」
 * 能不能被点开、能不能在页面之间走通、控制台干不干净。
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9337;
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=?(.*)$/);
    return m ? [m[1], m[2] || 'true'] : [a, 'true'];
  })
);
const START = args.url || 'https://local-tools.app.workbuddy.host/?sharecode=RZOBS5DDCE';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEV = join(process.cwd(), '..', '.dev');
const profile = join(DEV, 'chrome-profile-live');
mkdirSync(profile, { recursive: true });

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.log(`  ✗ ${msg}`);
  }
}

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--window-size=1280,1400',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate',
    START,
  ],
  { stdio: 'ignore' }
);

/* ---------- 连接 CDP ---------- */

let pageWs = null;
for (let i = 0; i < 60; i++) {
  await sleep(300);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    const page = list.find((t) => t.type === 'page' && t.url.startsWith('http'));
    if (page?.webSocketDebuggerUrl) {
      pageWs = page.webSocketDebuggerUrl;
      break;
    }
  } catch {}
}
if (!pageWs) {
  chrome.kill();
  throw new Error('无法连接 Chrome CDP');
}

const ws = new WebSocket(pageWs);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});

let msgId = 0;
const pending = new Map();
const errors = [];
const requests = [];
const failed = [];

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  } else if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    errors.push(d.exception?.description || d.text);
  } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
  } else if (msg.method === 'Network.requestWillBeSent') {
    requests.push(msg.params.request.url);
  } else if (msg.method === 'Network.loadingFailed') {
    // 被主动取消的请求不算错误（页面跳转会 cancel 正在进行的请求）
    if (!msg.params.canceled) failed.push(msg.params.errorText);
  }
});

function send(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve) => pending.set(id, resolve));
}

async function evalJS(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) {
    throw new Error(r.result.exceptionDetails.exception?.description || 'eval error');
  }
  return r.result?.result?.value;
}

/** 轮询等待条件成立，超时返回 false。不要用固定 sleep 判断就绪。 */
async function waitFor(expr, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if (await evalJS(expr)) return true;
    } catch {}
    await sleep(150);
  }
  return false;
}

await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable');

/* ---------- 1. 首页 ---------- */

console.log('\n=== 首页 ===');
const loaded = await waitFor(
  `document.readyState === 'complete' && document.querySelectorAll('.card[href]').length === 3 && document.styleSheets.length > 0`
);
ok(loaded, '首页加载完成，并列出了 3 个可点击的工具');

const homeUrl = await evalJS('location.href');
console.log(`  实际地址：${homeUrl.split('?')[0]}`);

const cards = await evalJS(`
  (() => ({
    titles: [...document.querySelectorAll('.card-title')].map(e => e.textContent.trim()),
    tags: [...document.querySelectorAll('.card .tag')].map(e => e.textContent.trim()),
    links: [...document.querySelectorAll('.card[href]')].map(e => e.getAttribute('href')),
    total: document.querySelectorAll('.card').length,
    clickable: document.querySelectorAll('.card[href]').length,
  }))()
`);
ok(cards.titles.length === 3, `卡片数量为 3，实际 [${cards.titles.join(' / ')}]`);
// 页面上不能有点不动的卡片：占位卡会让人以为整站还没做完
ok(cards.total === cards.clickable, `每张卡片都能点（${cards.clickable}/${cards.total} 可点击）`);
ok(
  cards.titles.join(',').includes('本地脱敏') &&
    cards.titles.join(',').includes('本地图片压缩') &&
    cards.titles.join(',').includes('本地 PDF 拆合'),
  '三个工具的标题都在'
);
ok(cards.tags.every((t) => t === '可用'), `没有「待上线」标记，实际 [${cards.tags.join(' / ')}]`);
ok(cards.links.every((h) => h && h.startsWith('./tools/')), '每个卡片都链到 ./tools/…');

/* ---------- 2. 逐页进入并返回 ---------- */

const expect = [
  { href: './tools/pii-mask/', h1: '本地脱敏', name: 'pii-mask' },
  { href: './tools/image-shrink/', h1: '本地图片压缩', name: 'image-shrink' },
  { href: './tools/pdf-toolkit/', h1: '本地 PDF 拆合', name: 'pdf-toolkit' },
];

for (const t of expect) {
  console.log(`\n=== 进入 ${t.h1} ===`);

  const before = await evalJS('location.pathname');
  await evalJS(`
    (() => {
      const a = [...document.querySelectorAll('.card[href]')].find(a => a.getAttribute('href') === ${JSON.stringify(t.href)});
      if (!a) throw new Error('找不到卡片');
      a.click();
      return true;
    })()
  `);

  // 等到 h1 是目标工具、且样式表已应用 —— 只判 h1 会撞上「HTML 已解析但 CSS 未生效」的瞬间
  const arrived = await waitFor(
    `document.readyState === 'complete' && location.pathname.replace(/\\/+$/, '') !== ${JSON.stringify(
      before.replace(/\/+$/, '')
    )} && document.querySelector('h1')?.textContent.trim() === ${JSON.stringify(t.h1)} && document.styleSheets.length > 0`
  );
  ok(arrived, `导航到 ${t.h1} 页（${t.href}）`);

  const path = await evalJS('location.pathname');
  ok(path.includes(t.name), `地址栏是 ${path}`);

  const detail = await evalJS(`
    (() => ({
      h1: document.querySelector('h1')?.textContent.trim(),
      back: document.querySelector('a.backlink')?.getAttribute('href') || null,
      styleOk: getComputedStyle(document.body).backgroundColor !== 'rgba(0, 0, 0, 0)',
      title: document.title,
    }))()
  `);
  ok(detail.h1 === t.h1, `标题正确：${detail.h1}`);
  ok(detail.back === '../../', `有返回入口，href=${detail.back}`);
  ok(detail.styleOk, '样式表加载成功（背景色已应用）');
  ok(detail.title.includes(t.h1.replace('本地 ', '')), `文档标题包含工具名：${detail.title.slice(0, 30)}…`);

  // 返回
  await evalJS(`document.querySelector('a.backlink').click(), true`);
  const backHome = await waitFor(
    `document.querySelector('h1')?.textContent.trim() === '本地工具' && document.querySelectorAll('.card[href]').length === 3`
  );
  ok(backHome, '点返回后回到工具列表');
}

/* ---------- 3. PDF 工具首屏不下载引擎 ---------- */

console.log('\n=== PDF 引擎按需加载 ===');
await evalJS(`
  (() => {
    const a = [...document.querySelectorAll('.card[href]')].find(a => a.getAttribute('href') === './tools/pdf-toolkit/');
    a.click();
    return true;
  })()
`);
await waitFor(`document.querySelector('h1')?.textContent.trim() === '本地 PDF 拆合' && document.styleSheets.length > 0`);
// 页面完全就绪后再多等一会儿，给「万一有懒加载」留出发请求的时间
await sleep(800);
const pdfReqs = requests.filter((u) => u.includes('pdf-lib')).length;
ok(pdfReqs === 0, `打开 PDF 页时没有请求 pdf-lib，实际 ${pdfReqs} 次`);

/* ---------- 4. 窄屏 ---------- */

console.log('\n=== 390px 窄屏 ===');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 780, deviceScaleFactor: 2, mobile: true });
await sleep(400);
const overflow = await evalJS(`
  (() => ({
    viewport: window.innerWidth,
    doc: document.documentElement.scrollWidth,
  }))()
`);
ok(overflow.doc <= overflow.viewport, `PDF 页无横向溢出（${overflow.doc} ≤ ${overflow.viewport}）`);

await evalJS(`document.querySelector('a.backlink').click(), true`);
await waitFor(`document.querySelector('h1')?.textContent.trim() === '本地工具'`);
const homeOverflow = await evalJS(`
  (() => ({ viewport: window.innerWidth, doc: document.documentElement.scrollWidth }))()
`);
ok(homeOverflow.doc <= homeOverflow.viewport, `首页无横向溢出（${homeOverflow.doc} ≤ ${homeOverflow.viewport}）`);
await send('Emulation.clearDeviceMetricsOverride');

/* ---------- 5. 控制台与网络 ---------- */

console.log('\n=== 控制台 / 网络 ===');
ok(errors.length === 0, `没有控制台错误${errors.length ? '：' + errors.slice(0, 3).join(' | ') : ''}`);
ok(failed.length === 0, `没有失败的请求${failed.length ? '：' + failed.slice(0, 3).join(' | ') : ''}`);

const byOrigin = {};
for (const u of requests) {
  try {
    byOrigin[new URL(u).hostname] = (byOrigin[new URL(u).hostname] || 0) + 1;
  } catch {}
}
const perOrigin = Object.entries(byOrigin)
  .map(([h, n]) => `${h}:${n}`)
  .join('  ');
console.log(`  请求来源：${perOrigin}`);
// 第三方 = 不是起始站点的域名。用起始 URL 反推，本地和线上同一份脚本都能跑。
const startHost = new URL(START).hostname;
const thirdParty = Object.keys(byOrigin).filter((h) => h !== startHost);
ok(thirdParty.length === 0, `没有第三方请求${thirdParty.length ? '：' + thirdParty.join(', ') : ''}`);
ok(requests.length > 0, `共记录 ${requests.length} 个请求（说明网络面板确实在工作，不是空采样）`);

/* ---------- 汇总 ---------- */

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
ws.close();
chrome.kill();
process.exit(fail === 0 ? 0 : 1);
