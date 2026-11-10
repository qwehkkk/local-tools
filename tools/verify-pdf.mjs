/**
 * 端到端验证：本地 PDF 拆合
 *
 * 核心原则：不信任页面自己报的数字，只信任从磁盘上拿回来的文件。
 * 每个产物都交给 Python 的 pypdf 独立解析 —— 它是另一个实现的读取器，
 * 如果 pdf-lib 写坏了结构，pypdf 会报错或页数对不上。
 *
 * 另外验证三件容易被忽略的事：
 *   1. 打开页面时不加载 523KB 引擎（懒加载是否真的生效）
 *   2. 上传字节恒为 0（文件没离开浏览器）
 *   3. 加密 PDF 必须明确报错，而不是静默产出空文件
 *
 * 用法：node tools/verify-pdf.mjs [--url=...]
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9337;

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=?(.*)$/);
    return m ? [m[1], m[2] || 'true'] : [a, 'true'];
  })
);
const URL_ = args.url || 'http://127.0.0.1:5180/tools/pdf-toolkit/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEV = resolve(process.cwd(), '..', '.dev');
const FIXTURES = resolve(DEV, 'fixtures');
const DOWNLOADS = resolve(DEV, 'downloads');
const SHOTS = resolve(DEV, 'shots');
const profile = resolve(DEV, 'chrome-profile');
for (const d of [profile, DOWNLOADS, SHOTS]) mkdirSync(d, { recursive: true });

const cleanDownloads = () => {
  for (const f of readdirSync(DOWNLOADS)) {
    try { rmSync(join(DOWNLOADS, f), { force: true }); } catch {}
  }
};
cleanDownloads();

const F = {
  contract: join(FIXTURES, '合同-扫描件.pdf'),
  invoice: join(FIXTURES, '发票.pdf'),
  single: join(FIXTURES, '单页附件.pdf'),
  encrypted: join(FIXTURES, '加密.pdf'),
};
for (const [k, p] of Object.entries(F)) {
  if (!existsSync(p)) throw new Error(`缺少测试文件 ${k}：${p}（先跑 python tools/make-pdf-fixtures.py）`);
}

let fails = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else { fails++; console.log(`  ✗ ${msg}`); }
};

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
    const page = list.find((t) => t.type === 'page' && t.url.includes('pdf-toolkit'));
    if (page?.webSocketDebuggerUrl) { pageWs = page.webSocketDebuggerUrl; break; }
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
  return new Promise((r) => pending.set(id, r));
}
async function evalJS(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) {
    throw new Error(r.result.exceptionDetails.exception?.description || 'eval error');
  }
  return r.result?.result?.value;
}

await send('Runtime.enable');
await send('Page.enable');
await send('DOM.enable');
await send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOADS }).catch(() => {});
await sleep(1000);

/* ---------------- 1. 打开页面：引擎必须还没加载 ---------------- */

console.log('=== 懒加载检查 ===');
const boot = await evalJS(`({
  engine: document.getElementById('engineSize').textContent.trim(),
  libReqs: performance.getEntriesByType('resource').filter((r) => /pdf-lib/.test(r.name)).length,
  runDisabled: document.getElementById('run').disabled,
})`);
console.log(`引擎状态：${boot.engine} · 已请求 pdf-lib 次数：${boot.libReqs}`);
ok(boot.engine === '未加载', `打开页面时引擎应为「未加载」，实际「${boot.engine}」`);
ok(boot.libReqs === 0, `打开页面时不应请求 pdf-lib，实际 ${boot.libReqs} 次`);
ok(boot.runDisabled === true, '没有文件时「生成」按钮应禁用');

/* ---------------- 2. 上传三个正常 PDF ---------------- */

console.log('\n=== 上传 ===');
const doc = await send('DOM.getDocument', { depth: -1 });
const q = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#files' });
if (!q.result?.nodeId) throw new Error('找不到文件输入框');
await send('DOM.setFileInputFiles', {
  nodeId: q.result.nodeId,
  files: [F.contract, F.invoice, F.single],
});
await evalJS(`document.getElementById('files').dispatchEvent(new Event('change', { bubbles: true })); true`);

for (let i = 0; i < 60; i++) {
  await sleep(250);
  const n = await evalJS(`document.querySelectorAll('.pdfrow').length`);
  const ready = await evalJS(`[...document.querySelectorAll('.pdfrow')].every((r) => !/正在读取/.test(r.textContent))`);
  if (n === 3 && ready) break;
}
await sleep(300);

const rowsInfo = await evalJS(`
  [...document.querySelectorAll('.pdfrow')].map((r) => ({
    name: r.querySelector('.pdfname').textContent,
    meta: r.querySelector('.pdfmeta').textContent,
    badge: r.querySelector('.pdfbadge').textContent,
    disabled: r.querySelector('input[data-role="range"]').disabled,
  }))
`);
for (const r of rowsInfo) console.log(`  [${r.badge}] ${r.name.padEnd(18)} ${r.meta}`);
ok(rowsInfo.length === 3, `应有 3 行，实际 ${rowsInfo.length}`);
ok(rowsInfo.map((r) => r.badge).join(',') === '3,2,1', `页数徽章应为 3,2,1，实际 ${rowsInfo.map((r) => r.badge).join(',')}`);
ok(rowsInfo.every((r) => !r.disabled), '正常文件的范围输入框应可用');

const afterLoad = await evalJS(`({
  engine: document.getElementById('engineSize').textContent.trim(),
  sent: document.getElementById('netSent').textContent.trim(),
  pages: document.getElementById('nPages').textContent,
  out: document.getElementById('nOut').textContent,
})`);
console.log(`引擎：${afterLoad.engine} · 上传字节：${afterLoad.sent} · 选中 ${afterLoad.pages} 页 · 将生成 ${afterLoad.out} 个文件`);
ok(afterLoad.engine !== '未加载', `上传后引擎应已加载，实际「${afterLoad.engine}」`);
ok(afterLoad.pages === '6' && afterLoad.out === '1', `默认应选中 6 页、生成 1 个文件，实际 ${afterLoad.pages}/${afterLoad.out}`);

/* ---------------- 3. 填页码范围 ---------------- */

console.log('\n=== 页码范围 ===');
await evalJS(`(() => {
  const inp = document.querySelectorAll('.pdfrow input[data-role="range"]')[0];
  inp.value = '2-3';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(200);
const afterRange = await evalJS(`({
  pages: document.getElementById('nPages').textContent,
  meta: document.querySelector('.pdfrow .pdfmeta').textContent,
})`);
console.log(`「合同-扫描件」填 2-3 → 选中 ${afterRange.pages} 页 · ${afterRange.meta}`);
ok(afterRange.pages === '5', `应选中 5 页（2+2+1），实际 ${afterRange.pages}`);

/* ---------------- 4. 合并并核对产物 ---------------- */

const PY_VERIFY = `
import sys, json, io, zipfile
from pypdf import PdfReader

def describe(path_or_bytes):
    r = PdfReader(path_or_bytes)
    return {
        "pages": len(r.pages),
        "dims": [[round(float(p.mediabox.width)), round(float(p.mediabox.height))] for p in r.pages],
        "encrypted": r.is_encrypted,
    }

mode = sys.argv[1]
if mode == "pdf":
    print(json.dumps(describe(sys.argv[2])))
else:
    z = zipfile.ZipFile(sys.argv[2])
    out = {"bad": z.testzip(), "entries": []}
    for name in z.namelist():
        rec = {"name": name}
        try:
            rec.update(describe(io.BytesIO(z.read(name))))
        except Exception as e:
            rec["error"] = repr(e)
        out["entries"].append(rec)
    print(json.dumps(out))
`;

const py = (mode, path) =>
  JSON.parse(execFileSync('python', ['-c', PY_VERIFY, mode, path], { encoding: 'utf8' }));

async function waitDownload(matchExt, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(250);
    const files = readdirSync(DOWNLOADS).filter((f) => f.toLowerCase().endsWith(matchExt));
    if (files.length) {
      const p = join(DOWNLOADS, files[0]);
      const s1 = statSync(p).size;
      await sleep(350);
      if (s1 > 0 && statSync(p).size === s1) return p;
    }
  }
  return null;
}

console.log('\n=== 合并 ===');
await evalJS(`document.getElementById('run').click(); true`);
const mergedPath = await waitDownload('.pdf');
ok(!!mergedPath, '已拿到合并后的 PDF');
if (mergedPath) {
  const r = py('pdf', mergedPath);
  const size = statSync(mergedPath).size;
  console.log(`产物：${mergedPath.split(/[\\/]/).pop()}  ${(size / 1024).toFixed(1)} KB`);
  console.log(`页数 ${r.pages} · 尺寸 ${JSON.stringify(r.dims)}`);
  ok(r.pages === 5, `合并结果应为 5 页，实际 ${r.pages}`);
  ok(
    JSON.stringify(r.dims) === JSON.stringify([[500, 500], [400, 600], [420, 595], [420, 595], [300, 300]]),
    '页序与页面尺寸符合预期（页码选择 + 文件顺序）'
  );
  ok(r.encrypted === false, '产物不应被加密');
}

/* ---------------- 5. 拆分打包 ---------------- */

console.log('\n=== 拆分 ===');
cleanDownloads();
await evalJS(`(() => {
  document.querySelector('#modeSeg button[data-mode="split"]').click();
  document.querySelector('#splitMode').value = 'each';
  document.querySelector('#splitMode').dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);
await sleep(200);
const splitState = await evalJS(`({
  out: document.getElementById('nOut').textContent,
  label: document.getElementById('run').textContent.trim(),
  splitVisible: !document.getElementById('splitCtrl').hidden,
})`);
console.log(`将生成 ${splitState.out} 个文件 · 按钮文案「${splitState.label}」`);
ok(splitState.out === '5', `每页一个文件应生成 5 个，实际 ${splitState.out}`);
ok(splitState.splitVisible, '拆分模式下应显示拆分方式选择');
ok(/拆分/.test(splitState.label), `按钮文案应变为拆分，实际「${splitState.label}」`);

await evalJS(`document.getElementById('run').click(); true`);
const zipPath = await waitDownload('.zip');
ok(!!zipPath, '已拿到拆分后的 ZIP');
if (zipPath) {
  const z = py('zip', zipPath);
  console.log(`ZIP ${(statSync(zipPath).size / 1024).toFixed(1)} KB · CRC ${z.bad === null ? '通过' : '损坏'}`);
  for (const e of z.entries) console.log(`  ${e.name.padEnd(24)} ${e.pages ?? '?'} 页 ${JSON.stringify(e.dims ?? [])}`);
  ok(z.bad === null, 'ZIP 结构完好（CRC 通过）');
  ok(z.entries.length === 5, `ZIP 应有 5 个 PDF，实际 ${z.entries.length}`);
  ok(z.entries.every((e) => e.pages === 1), '每个拆分文件应各含 1 页');
  ok(
    z.entries.every((e) => /合同-扫描件_第[23]页/.test(e.name) || /发票_第[12]页/.test(e.name) || /单页附件_第1页/.test(e.name)),
    '拆分文件名正确，中文不乱码'
  );
}

/* ---------------- 6. 非法页码必须被拦下 ---------------- */

console.log('\n=== 非法输入 ===');
cleanDownloads();
await evalJS(`(() => {
  const inp = document.querySelectorAll('.pdfrow input[data-role="range"]')[1];
  inp.value = '9-12';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(200);
const bad = await evalJS(`({
  meta: document.querySelectorAll('.pdfrow .pdfmeta')[1].textContent,
  metaBad: document.querySelectorAll('.pdfrow .pdfmeta')[1].classList.contains('bad'),
  inputBad: document.querySelectorAll('.pdfrow input[data-role="range"]')[1].classList.contains('bad'),
  pages: document.getElementById('nPages').textContent,
})`);
console.log(`提示：${bad.meta} · 选中 ${bad.pages} 页`);
ok(bad.metaBad && bad.inputBad, '非法页码应把提示和输入框标红');
ok(/超出总页数/.test(bad.meta), `提示应说明超出总页数，实际「${bad.meta}」`);

await evalJS(`document.getElementById('run').click(); true`);
await sleep(1200);
const toastText = await evalJS(`document.getElementById('toast').textContent`);
const leaked = readdirSync(DOWNLOADS).length;
console.log(`点生成后的提示：${toastText}`);
ok(/超出总页数|页码范围/.test(toastText), '非法页码时点生成应被明确拦下');
ok(leaked === 0, `非法输入不应产出文件，实际落了 ${leaked} 个`);

/* ---------------- 7. 加密 PDF ---------------- */

console.log('\n=== 加密 PDF ===');
const doc2 = await send('DOM.getDocument', { depth: -1 });
const q2 = await send('DOM.querySelector', { nodeId: doc2.result.root.nodeId, selector: '#files' });
await send('DOM.setFileInputFiles', { nodeId: q2.result.nodeId, files: [F.encrypted] });
await evalJS(`document.getElementById('files').dispatchEvent(new Event('change', { bubbles: true })); true`);

for (let i = 0; i < 40; i++) {
  await sleep(250);
  const n = await evalJS(`document.querySelectorAll('.pdfrow').length`);
  if (n === 4) break;
}
await sleep(600);
const encRow = await evalJS(`
  (() => {
    const rows = [...document.querySelectorAll('.pdfrow')];
    const r = rows[rows.length - 1];
    return {
      name: r.querySelector('.pdfname').textContent,
      meta: r.querySelector('.pdfmeta').textContent,
      cls: r.className,
      disabled: r.querySelector('input[data-role="range"]').disabled,
      files: document.getElementById('nFiles').textContent,
      pages: document.getElementById('nPages').textContent,
    };
  })()
`);
console.log(`「${encRow.name}」→ ${encRow.meta}`);
ok(/密码/.test(encRow.meta), `加密文件应明确提示密码问题，实际「${encRow.meta}」`);
ok(/bad/.test(encRow.cls), '加密文件那一行应标红');
ok(encRow.disabled === true, '加密文件的页码输入应禁用');
ok(encRow.pages === '3', `加密文件不应计入选中页数（此时应为 3 页），实际 ${encRow.pages}`);

/* ---------------- 8. 上传字节 ---------------- */

console.log('\n=== 零上传 ===');
const net = await evalJS(`({
  sent: document.getElementById('netSent').textContent.trim(),
  lib: performance.getEntriesByType('resource').filter((r) => /pdf-lib/.test(r.name))
        .map((r) => Math.round((r.encodedBodySize || r.decodedBodySize || 0) / 1024)),
})`);
console.log(`上传 ${net.sent} 字节 · 引擎体积 ${net.lib.join(',')} KB`);
ok(net.sent === '0', `上传字节应为 0，实际 ${net.sent}`);
ok(net.lib.length === 1 && net.lib[0] > 300, `引擎应只加载一次且体积合理，实际 ${JSON.stringify(net.lib)}`);

/* ---------------- 9. 窄屏 ---------------- */

console.log('\n=== 390px 窄屏 ===');
await send('Emulation.setDeviceMetricsOverride', {
  width: 390, height: 780, deviceScaleFactor: 1, mobile: true,
});
await sleep(500);
const narrow = await evalJS(`(() => {
  const de = document.documentElement;
  const rowsEl = document.getElementById('rows');
  const over = [...document.querySelectorAll('*')]
    .filter((el) => el.getBoundingClientRect().right > de.clientWidth + 1)
    .slice(0, 6)
    .map((el) => el.tagName + '.' + (el.className || '') + ' right=' + Math.round(el.getBoundingClientRect().right));
  return {
    clientWidth: de.clientWidth,
    scrollWidth: de.scrollWidth,
    rowsScroll: rowsEl.scrollWidth,
    rowsClient: rowsEl.clientWidth,
    over,
  };
})()`);
console.log(`视口 ${narrow.clientWidth}px · 内容 ${narrow.scrollWidth}px · 列表内 ${narrow.rowsScroll}/${narrow.rowsClient}px`);
if (narrow.over.length) console.log(`溢出元素：\n  ${narrow.over.join('\n  ')}`);
ok(narrow.scrollWidth <= narrow.clientWidth + 1, `窄屏整页无横向溢出（${narrow.scrollWidth} ≤ ${narrow.clientWidth}）`);
ok(narrow.rowsScroll <= narrow.rowsClient + 1, `列表容器内部无横向溢出（${narrow.rowsScroll} ≤ ${narrow.rowsClient}）`);

// 截图前藏掉提示条：它是 fixed 定位，在长截图里会盖住文件列表，影响看布局
await evalJS(`document.getElementById('toast').style.display = 'none'; true`);
const mob = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
await evalJS(`document.getElementById('toast').style.display = ''; true`);
writeFileSync(join(SHOTS, 'pdf-toolkit-mobile.png'), Buffer.from(mob.result.data, 'base64'));
await send('Emulation.clearDeviceMetricsOverride');
await sleep(300);

/* ---------------- 10. 桌面截图 + 控制台 ---------------- */

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
const shotPath = join(SHOTS, 'pdf-toolkit.png');
writeFileSync(shotPath, Buffer.from(shot.result.data, 'base64'));

console.log('\n=== 结论 ===');
console.log(`控制台错误：${errors.length} 条`);
if (errors.length) errors.slice(0, 3).forEach((e) => console.log('  - ' + String(e).slice(0, 200)));
ok(errors.length === 0, '不应有控制台错误');
console.log(`截图：${shotPath}`);
console.log(fails === 0 ? '\n全部断言通过' : `\n${fails} 条断言失败`);

ws.close();
chrome.kill();
process.exit(fails === 0 ? 0 : 1);
