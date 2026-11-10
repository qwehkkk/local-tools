/**
 * 端到端验证：真实 Chrome 打开脱敏工具，注入样例文本，
 * 读取识别结果 / 脱敏输出 / 控制台错误，并截图。
 *
 * 用法：node tools/verify.mjs [--url=...] [--shot=path]
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9334;
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=?(.*)$/);
    return m ? [m[1], m[2] || 'true'] : [a, 'true'];
  })
);
const URL_ = args.url || 'http://127.0.0.1:5180/tools/pii-mask/';
const SHOT = args.shot || join(process.cwd(), '..', '.dev', 'shots', 'pii-mask.png');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 开发产物（Chrome 配置、截图）放在发布目录之外，避免被打包上线
const DEV = join(process.cwd(), '..', '.dev');
const profile = join(DEV, 'chrome-profile');
mkdirSync(profile, { recursive: true });
mkdirSync(join(DEV, 'shots'), { recursive: true });

const SAMPLE = `合同补充协议

甲方：张伟
身份证号：110101199003078515
联系电话：13812345678
电子邮箱：zhang.wei@example.com
收款账户：4111111111111111
通讯地址：广东省深圳市南山区科技园南路18号
车牌：京A12345
开票抬头：深圳市腾讯计算机系统有限公司
合同编号：HT20261108A

本月结算金额 42000 元，共 35 件商品，签字页见第 8 页。`;

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
    URL_,
  ],
  { stdio: 'ignore' }
);

let pageWs = null;
for (let i = 0; i < 60; i++) {
  await sleep(300);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    const page = list.find((t) => t.type === 'page' && t.url.includes('pii-mask'));
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

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  } else if (msg.method === 'Runtime.exceptionThrown') {
    errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
  } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
  }
});

function send(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve) => pending.set(id, resolve));
}

async function evalJS(expression) {
  const r = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.result?.exceptionDetails) {
    throw new Error(r.result.exceptionDetails.exception?.description || 'eval error');
  }
  return r.result?.result?.value;
}

await send('Runtime.enable');
await send('Page.enable');
await sleep(900);

// 注入样例并触发 input（走真实事件路径，不是直接改输出）
await evalJS(`
  (() => {
    const el = document.getElementById('input');
    el.value = ${JSON.stringify(SAMPLE)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()
`);
await sleep(500);

const result = await evalJS(`
  (() => ({
    counter: document.getElementById('counter').innerText,
    stats: document.getElementById('stats').innerText,
    output: document.getElementById('output').value,
    netCount: document.getElementById('netCount').innerText,
    marks: document.querySelectorAll('#preview mark.hit').length,
    rulesCount: document.querySelectorAll('#rulesPanel input').length,
  }))()
`);

// 点击第一个高亮，验证「保留/遮盖」切换
const toggle = await evalJS(`
  (() => {
    const m = document.querySelector('#preview mark.hit');
    if (!m) return null;
    const raw = m.textContent;
    m.click();
    return { raw, kept: document.querySelector('#preview mark.hit')?.classList.contains('keep') };
  })()
`);
await sleep(250);
const afterToggle = await evalJS(`document.getElementById('output').value`);
// 还原
await evalJS(`document.querySelector('#preview mark.hit')?.click()`);
await sleep(250);

// 截图
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
if (shot.result?.data) {
  writeFileSync(SHOT, Buffer.from(shot.result.data, 'base64'));
}

console.log('=== 识别 ===');
console.log(result.counter);
console.log('类型分布：', result.stats.replace(/\n/g, ' | '));
console.log('高亮节点数：', result.marks, ' 规则数：', result.rulesCount);
console.log('页面网络请求计数：', result.netCount);
console.log('');
console.log('=== 脱敏输出 ===');
console.log(result.output);
console.log('');
console.log('=== 点击切换 ===');
if (toggle) {
  console.log(`点击「${toggle.raw}」→ 该处变为${toggle.kept ? '保留（不遮盖）' : '遮盖'}`);
  console.log('切换后输出是否仍包含原文：', afterToggle.includes(toggle.raw));
} else {
  console.log('未找到高亮项');
}
console.log('');
console.log('=== 控制台错误 ===');
console.log(errors.length ? errors.join('\n') : '无');
console.log('');
/* ---------- 三种遮盖模式 ---------- */
const modes = {};
for (const m of ['full', 'token', 'partial']) {
  await evalJS(`document.querySelector('#modeSeg button[data-mode="${m}"]').click()`);
  await sleep(200);
  modes[m] = await evalJS(`document.getElementById('output').value`);
}
console.log('=== 遮盖模式 ===');
console.log('partial:', modes.partial.split('\n')[2]);
console.log('full   :', modes.full.split('\n')[2]);
console.log('token  :', modes.token.split('\n')[2]);
const modeOk =
  !modes.full.includes('110101199003078515') &&
  modes.token.includes('〔') &&
  modes.partial.includes('110101********8515');
console.log('三种模式输出均符合预期：', modeOk);

/* ---------- 映射表与还原闭环 ---------- */
await evalJS(`document.getElementById('sampleBtn').click()`);
await sleep(300);
await evalJS(`document.querySelector('#modeSeg button[data-mode="token"]').click()`);
await sleep(400);

const mapInfo = await evalJS(`
  (() => {
    const rows = [...document.querySelectorAll('#mapTable tbody tr')]
      .map(tr => [...tr.children].map(td => td.textContent));
    return {
      count: document.getElementById('mapCount').textContent,
      hint: document.getElementById('mapHint').textContent,
      rows,
      masked: document.getElementById('output').value,
    };
  })()
`);

console.log('');
console.log('=== 映射表 ===');
console.log(mapInfo.count, '|', mapInfo.hint);
mapInfo.rows.slice(0, 4).forEach((r) => console.log('  ', r.join(' | ')));
const zhangTokens = (mapInfo.masked.match(/〔姓名\d+〕/g) || []);
console.log('占位符编号复用检查：张伟出现', zhangTokens.length, '次 →', [...new Set(zhangTokens)].join(','));

// 切到还原页签，应自动带上当前脱敏结果
await evalJS(`document.querySelector('#tabs button[data-tab="restore"]').click()`);
await sleep(600);
const rinfo = await evalJS(`
  (() => ({
    src: document.getElementById('restoreSrc').textContent,
    filled: document.getElementById('restoreIn').value,
    out: document.getElementById('restoreOut').textContent,
    stat: document.getElementById('restoreStat').textContent,
  }))()
`);

console.log('');
console.log('=== 还原闭环 ===');
console.log(rinfo.src);
console.log('自动带入：', rinfo.filled.slice(0, 40).replace(/\n/g, ' ') + '…');
console.log('统计：', rinfo.stat);
const roundTripOk =
  rinfo.out.includes('110101199003078515') &&
  rinfo.out.includes('13812345678') &&
  rinfo.out.includes('张伟') &&
  !rinfo.out.includes('〔');
console.log('还原后与原文一致（关键字段回位、无残留占位符）：', roundTripOk);

await evalJS(`document.querySelector('#tabs button[data-tab="mask"]').click()`);
await sleep(300);

/* ---------- 大文本性能 ---------- */
const perf = await evalJS(`
  (() => {
    const unit = '客户 张伟 身份证 110101199003078515 手机 13812345678 地址 广东省深圳市南山区科技园南路18号 邮箱 a@b.com\\n';
    const big = unit.repeat(1200);
    const el = document.getElementById('input');
    const t0 = performance.now();
    el.value = big;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return { chars: big.length };
  })()
`);
await sleep(1500);
const perfOut = await evalJS(`
  (() => ({
    marks: document.querySelectorAll('#preview mark.hit').length,
    counter: document.getElementById('counter').innerText,
    outLen: document.getElementById('output').value.length,
  }))()
`);
console.log('');
console.log('=== 大文本 ===');
console.log(`输入 ${perf.chars} 字符 → 高亮 ${perfOut.marks} 处，输出 ${perfOut.outLen} 字符`);
console.log(perfOut.counter);

/* ---------- 移动端 ---------- */
await evalJS(`document.getElementById('sampleBtn').click()`);
await sleep(300);
await send('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 2,
  mobile: true,
});
await sleep(500);
const mobShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
if (mobShot.result?.data) {
  writeFileSync(join(DEV, 'shots', 'pii-mask-mobile.png'), Buffer.from(mobShot.result.data, 'base64'));
}
await send('Emulation.clearDeviceMetricsOverride');

console.log('');
console.log('截图：', SHOT);
console.log('移动端截图：', join(DEV, 'shots', 'pii-mask-mobile.png'));

ws.close();
chrome.kill();
process.exit(0);
