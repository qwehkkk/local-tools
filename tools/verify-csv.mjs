/**
 * 验证「导出 CSV → 新开页面 → 导入 CSV → 还原」这条真实用户路径。
 * 新开页面意味着内存里没有任何映射表，只能靠文件。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { detect, buildMapping, mappingToCSV } from '../assets/pii-rules.js';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9337;
const URL_ = process.argv.find((a) => a.startsWith('--url='))?.slice(6) || 'http://127.0.0.1:5180/tools/pii-mask/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEV = join(process.cwd(), '..', '.dev');
mkdirSync(DEV, { recursive: true });

// 1. 造一份"用户之前下载的"映射表
const SRC = '甲方：张伟，身份证 110101199003078515，手机 13812345678，地址 广东省深圳市南山区科技园南路18号。另一联系人为王芳。';
const findings = detect(SRC);
const csvPath = join(DEV, 'test-map.csv');
writeFileSync(csvPath, mappingToCSV(buildMapping(findings)), 'utf-8');
console.log('生成的映射表 CSV：', csvPath);

// 2. 模拟对方返回的内容（占位符 + 一句新话）
const RETURNED = '关于〔姓名1〕的合同，身份证〔身份证号1〕已核验，回电〔手机号1〕，寄送地址〔地址1〕。另：〔姓名2〕下周到岗。';

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${join(DEV, 'chrome-profile')}`,
    '--window-size=1280,900',
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
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description);
  return r.result?.result?.value;
};

await send('Runtime.enable');
await send('Page.enable');
await send('DOM.enable');
await sleep(900);

// 3. 确认新页面内存里确实没有映射表
const initial = await evalJS(`document.getElementById('restoreSrc')?.textContent`);
console.log('导入前还原页状态：', initial ?? '(未渲染)');

// 4. 切到还原页签
await evalJS(`document.querySelector('#tabs button[data-tab="restore"]').click()`);
await sleep(400);

// 5. 通过真实文件选择器导入 CSV
const doc = await send('DOM.getDocument', { depth: 1 });
const node = await send('DOM.querySelector', {
  nodeId: doc.result.root.nodeId,
  selector: '#csvFile',
});
await send('DOM.setFileInputFiles', { nodeId: node.result.nodeId, files: [csvPath] });
await sleep(900);

const afterImport = await evalJS(`document.getElementById('restoreSrc').textContent`);
console.log('导入后：', afterImport);

// 6. 粘贴对方返回的内容，看还原结果
await evalJS(`
  (() => {
    const el = document.getElementById('restoreIn');
    el.value = ${JSON.stringify(RETURNED)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()
`);
await sleep(700);

const result = await evalJS(`
  (() => ({
    out: document.getElementById('restoreOut').textContent,
    stat: document.getElementById('restoreStat').textContent,
    info: document.getElementById('restoreInfo').textContent,
  }))()
`);

console.log('');
console.log('=== 对方返回 ===');
console.log(RETURNED);
console.log('');
console.log('=== 还原结果 ===');
console.log(result.out);
console.log('');
console.log('统计：', result.stat);
if (result.info) console.log('提示：', result.info);
console.log('');
const ok =
  result.out.includes('张伟') &&
  result.out.includes('110101199003078515') &&
  result.out.includes('13812345678') &&
  result.out.includes('王芳') &&
  !/〔/.test(result.out);
console.log('CSV 导入 → 还原 全链路正确：', ok);

ws.close();
chrome.kill();
process.exit(0);
