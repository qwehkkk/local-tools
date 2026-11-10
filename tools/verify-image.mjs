/**
 * 端到端验证：真实 Chrome 打开图片压缩工具，真实上传 6 张图，
 * 走完整处理流程，点「全部下载」拿到真实 ZIP，
 * 再用 Python 的 zipfile + PIL 反向校验产物是不是真的可用图片。
 *
 * 关键点：不信任页面自己报的数字，只信任从磁盘上拿回来的文件。
 *
 * 用法：node tools/verify-image.mjs [--url=...]
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readdirSync, statSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9336;

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=?(.*)$/);
    return m ? [m[1], m[2] || 'true'] : [a, 'true'];
  })
);
const URL_ = args.url || 'http://127.0.0.1:5180/tools/image-shrink/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEV = join(process.cwd(), '..', '.dev');
const FIXTURES = resolve(DEV, 'fixtures');
const DOWNLOADS = resolve(DEV, 'downloads');
const SHOTS = resolve(DEV, 'shots');
const profile = join(DEV, 'chrome-profile');
for (const d of [profile, DOWNLOADS, SHOTS]) mkdirSync(d, { recursive: true });

// 清掉上一次的下载，避免把旧文件当成新产物
for (const f of readdirSync(DOWNLOADS)) {
  try { rmSync(join(DOWNLOADS, f), { force: true }); } catch {}
}

const UPLOAD = [
  'photo-large.jpg',
  'alpha.png',
  'already.webp',
  'tiny.png',
  'anim.gif',
  '合同 扫描件.jpg',
].map((f) => join(FIXTURES, f));

for (const f of UPLOAD) {
  if (!existsSync(f)) throw new Error(`缺少测试图：${f}（先跑 python tools/make-fixtures.py）`);
}

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--window-size=1280,1500',
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
    const page = list.find((t) => t.type === 'page' && t.url.includes('image-shrink'));
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
  return new Promise((resolve) => pending.set(id, resolve));
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
await sleep(900);

/* ---------------- 上传真实文件 ---------------- */

const doc = await send('DOM.getDocument', { depth: -1 });
const q = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#files' });
if (!q.result?.nodeId) throw new Error('找不到文件输入框');

await send('DOM.setFileInputFiles', { nodeId: q.result.nodeId, files: UPLOAD });

// setFileInputFiles 未必触发 change，补一次（addFiles 内部有去重，不会重复入列）
await evalJS(`document.getElementById('files').dispatchEvent(new Event('change', { bubbles: true })); true`);

/* ---------------- 等待处理完成 ---------------- */

let doneCount = 0;
let errCount = 0;
for (let i = 0; i < 160; i++) {
  await sleep(250);
  doneCount = await evalJS(`document.querySelectorAll('.row.is-done').length`);
  errCount = await evalJS(`document.querySelectorAll('.row.is-error').length`);
  if (doneCount + errCount >= UPLOAD.length) break;
  // 出现无法解码的（GIF 首帧应可解，这里只防死等）
  if (i > 120) break;
}
await sleep(400);

console.log('=== 处理结果 ===');
const rows = await evalJS(`
  [...document.querySelectorAll('.row')].map((r) => ({
    name: r.querySelector('.rowname')?.textContent.trim(),
    meta: r.querySelector('.rowmeta')?.textContent.trim(),
    sizes: r.querySelector('.rowsizes')?.textContent.trim(),
    save: r.querySelector('.rowsave')?.textContent.trim(),
    cls: r.className,
  }))
`);
for (const r of rows) {
  console.log(`${(r.name || '').padEnd(20)} ${(r.sizes || '-').padEnd(24)} ${(r.save || '').padEnd(7)} ${r.meta || ''}`);
}

const summary = await evalJS(`({
  total: document.getElementById('nTotal').textContent,
  sumIn: document.getElementById('sumIn').textContent,
  sumOut: document.getElementById('sumOut').textContent,
  save: document.getElementById('sumSave').textContent,
  net: document.getElementById('netCount').textContent,
})`);
console.log('');
console.log(`共 ${summary.total} 张 · 原始 ${summary.sumIn} → 输出 ${summary.sumOut} · 节省 ${summary.save}`);
console.log(`页面网络请求计数：${summary.net}`);

/* ---------------- 点「全部下载」，拿真实 ZIP ---------------- */

async function grabZip() {
  // 每次下载前清空，避免把上一次的产物当成这一次的
  for (const f of readdirSync(DOWNLOADS)) {
    try { rmSync(join(DOWNLOADS, f), { force: true }); } catch {}
  }
  const label = await evalJS(`
    (() => {
      const b = document.getElementById('downloadAll');
      if (b.disabled) return 'disabled';
      b.click();
      return b.textContent;
    })()
  `);
  console.log(`点击下载按钮：${label}`);

  for (let i = 0; i < 100; i++) {
    await sleep(250);
    const files = readdirSync(DOWNLOADS).filter((f) => f.endsWith('.zip'));
    if (!files.length) continue;
    const p = join(DOWNLOADS, files[0]);
    const s1 = statSync(p).size;
    await sleep(400);
    const s2 = statSync(p).size;
    if (s1 === s2 && s1 > 0) return p;
  }
  throw new Error('没有拿到下载的 ZIP 文件');
}

function inspectZip(path) {
  const py = `
import zipfile, json, sys, io
from PIL import Image

z = zipfile.ZipFile(sys.argv[1])
bad = z.testzip()
items = []
for name in z.namelist():
    b = z.read(name)
    rec = {"name": name, "bytes": len(b)}
    try:
        im = Image.open(io.BytesIO(b))
        im.load()
        rec.update({
            "format": im.format, "w": im.width, "h": im.height, "mode": im.mode,
        })
        if im.mode in ("RGBA", "LA"):
            alpha = im.getchannel("A")
            lo, hi = alpha.getextrema()
            rec["alpha_range"] = [lo, hi]
    except Exception as e:
        rec["error"] = repr(e)
    items.append(rec)
print(json.dumps({"bad": bad, "items": items}, ensure_ascii=False))
`;
  return JSON.parse(execFileSync('python', ['-c', py, path], { encoding: 'utf8' }));
}

const zipPath = await grabZip();
const zipSize = statSync(zipPath).size;
console.log(`ZIP 已落盘：${zipPath}  ${(zipSize / 1024).toFixed(1)} KB`);

/* ---------------- 用 Python 反向校验产物 ---------------- */

const zipCheck = inspectZip(zipPath);

console.log('\n=== ZIP 内产物真实校验（zipfile + PIL 读回）===');
console.log(`CRC 损坏条目：${zipCheck.bad === null ? '无' : zipCheck.bad}`);
for (const it of zipCheck.items) {
  if (it.error) {
    console.log(`  ✗ ${it.name}  ${it.bytes} B  无法解码：${it.error}`);
  } else {
    const alpha = it.alpha_range ? ` alpha[${it.alpha_range[0]}..${it.alpha_range[1]}]` : '';
    console.log(`  ✓ ${it.name.padEnd(24)} ${it.format.padEnd(5)} ${String(it.w) + '×' + String(it.h)}  ${it.mode.padEnd(5)} ${(it.bytes / 1024).toFixed(1)} KB${alpha}`);
  }
}

/* ---------------- 断言 ---------------- */

const byName = Object.fromEntries(zipCheck.items.map((i) => [i.name, i]));
const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); };

ok(zipCheck.bad === null, 'ZIP 结构完好（CRC 通过）');
ok(zipCheck.items.length === UPLOAD.length, `ZIP 条目数应为 ${UPLOAD.length}，实际 ${zipCheck.items.length}`);
ok(zipCheck.items.every((i) => !i.error), '有产物无法被 PIL 解码');

// 除「保留原图」的条目外，其余都应转成 WebP。
// tiny.png 本来就极小，转 WebP 只会更大，按 keepSmaller 设计保留原格式——这是正确行为。
const notWebp = zipCheck.items.filter((i) => i.format !== 'WEBP').map((i) => i.name);
ok(
  notWebp.length === 0 || (notWebp.length === 1 && notWebp[0] === 'tiny.png'),
  `非预期格式：${notWebp.join(' / ')}`
);

// 缩放到 1920 长边
const photo = byName['photo-large.webp'];
ok(!!photo, '缺少 photo-large.webp');
if (photo) {
  ok(photo.w === 1920 && photo.h === 1280, `photo 应缩放到 1920×1280，实际 ${photo.w}×${photo.h}`);
  ok(photo.bytes < 1381 * 1024 * 0.4, `photo 压缩率不足：${(photo.bytes / 1024).toFixed(0)}KB`);
}

// 透明通道必须保留
const alpha = byName['alpha.webp'];
ok(!!alpha, '缺少 alpha.webp');
if (alpha) {
  ok(alpha.mode === 'RGBA', `透明 PNG 输出应为 RGBA，实际 ${alpha.mode}`);
  ok(alpha.alpha_range && alpha.alpha_range[0] < 255, '透明信息丢失（alpha 全为 255）');
}

// 压不动的应保留原图，且扩展名跟着变
const tiny = byName['tiny.png'];
ok(!!tiny, '缺少 tiny.png（说明未按「保留原图」处理）');

// 中文文件名在 ZIP 中不能乱码
ok(!!byName['合同 扫描件.webp'], `中文文件名丢失或被改名，实际条目：${zipCheck.items.map((i) => i.name).join(' / ')}`);
ok(!!byName['anim.webp'], '缺少 anim.webp（GIF 首帧应能处理）');

ok(String(summary.net) === '0', `页面发出了 ${summary.net} 个网络请求，应为 0`);
ok(errors.length === 0, `控制台有 ${errors.length} 条错误：${errors.join(' | ')}`);

/* ---------------- 控件可见性（防「hidden 被 CSS 架空」回归） ---------------- */

const vis = await evalJS(`({
  quality: document.getElementById('qualityCtrl').offsetParent !== null,
  size: document.getElementById('sizeCtrl').offsetParent !== null,
  mode: [...document.querySelectorAll('#modeSeg button')].find((b) => b.getAttribute('aria-pressed') === 'true')?.dataset.mode,
})`);
console.log(`\n=== 控件可见性（按质量模式）===`);
console.log(`质量滑块可见=${vis.quality} · 目标大小输入可见=${vis.size} · 当前模式=${vis.mode}`);
ok(vis.quality === true, '按质量模式下质量滑块应可见');
ok(vis.size === false, '按质量模式下目标大小输入不应可见（hidden 被 CSS 覆盖了？）');

/* ---------------- 按目标大小模式 ---------------- */

async function waitDone(expect) {
  for (let i = 0; i < 160; i++) {
    await sleep(250);
    const d = await evalJS(`document.querySelectorAll('.row.is-done').length`);
    const e = await evalJS(`document.querySelectorAll('.row.is-error').length`);
    if (d + e >= expect) return { d, e };
  }
  return { d: -1, e: -1 };
}

const TARGET_KB = 60;
await evalJS(`
  (() => {
    [...document.querySelectorAll('#modeSeg button')].find((b) => b.dataset.mode === 'size').click();
    const t = document.getElementById('targetKB');
    t.value = '${TARGET_KB}';
    t.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()
`);
await sleep(400);
const after = await waitDone(UPLOAD.length);

const vis2 = await evalJS(`({
  quality: document.getElementById('qualityCtrl').offsetParent !== null,
  size: document.getElementById('sizeCtrl').offsetParent !== null,
})`);
ok(vis2.quality === false, '切到目标大小模式后质量滑块应隐藏');
ok(vis2.size === true, '切到目标大小模式后目标大小输入应可见');

const zip2Path = await grabZip();
const zip2 = inspectZip(zip2Path);

console.log(`\n=== 按目标大小 ${TARGET_KB} KB 的实际产物 ===`);
let overshoot = 0;
for (const it of zip2.items) {
  const kb = it.bytes / 1024;
  const over = kb > TARGET_KB;
  if (over) overshoot++;
  console.log(`  ${over ? '✗' : '✓'} ${it.name.padEnd(24)} ${kb.toFixed(1).padStart(7)} KB  ${it.format} ${it.w}×${it.h}`);
}
console.log(`处理完成 ${after.d} 张，失败 ${after.e} 张`);
ok(after.d === UPLOAD.length && after.e === 0, `目标大小模式有失败项：done=${after.d} error=${after.e}`);
ok(overshoot === 0, `有 ${overshoot} 个产物超过 ${TARGET_KB}KB 目标`);

// 最根本的一条：压缩工具任何时候都不该产出比原图更大的文件。
const srcSizeByBase = Object.fromEntries(
  UPLOAD.map((p) => [p.split(/[\\/]/).pop().replace(/\.[^.]+$/, ''), statSync(p).size])
);
const inflated = zip2.items.filter((it) => {
  const base = it.name.replace(/\.[^.]+$/, '');
  const src = srcSizeByBase[base];
  return src !== undefined && it.bytes > src;
});
ok(
  inflated.length === 0,
  `有产物比原图更大：${inflated.map((i) => `${i.name} ${(i.bytes / 1024).toFixed(1)}KB`).join(' / ')}`
);

// 切回按质量模式，让截图反映默认状态
await evalJS(`
  (() => {
    [...document.querySelectorAll('#modeSeg button')].find((b) => b.dataset.mode === 'quality').click();
    return true;
  })()
`);
await waitDone(UPLOAD.length);
await sleep(500);

/* ---------------- 截图 ---------------- */

const desk = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
writeFileSync(join(SHOTS, 'image-shrink.png'), Buffer.from(desk.result.data, 'base64'));

await send('Emulation.setDeviceMetricsOverride', {
  width: 390, height: 780, deviceScaleFactor: 2, mobile: true,
});
await sleep(600);
const mob = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(join(SHOTS, 'image-shrink-mobile.png'), Buffer.from(mob.result.data, 'base64'));

// 窄屏溢出测量
const overflow = await evalJS(`(() => {
  const de = document.documentElement;
  const over = [...document.querySelectorAll('*')]
    .filter((el) => el.getBoundingClientRect().right > de.clientWidth + 1)
    .slice(0, 6)
    .map((el) => el.tagName + '.' + (el.className || '') + ' right=' + Math.round(el.getBoundingClientRect().right));
  // 列表容器是 overflow:auto，内部溢出不会让整页滚动，只看 documentElement 会漏掉
  const rows = document.querySelector('.rows');
  return {
    clientWidth: de.clientWidth,
    scrollWidth: de.scrollWidth,
    over,
    rowsScrollWidth: rows ? rows.scrollWidth : -1,
    rowsClientWidth: rows ? rows.clientWidth : -1,
  };
})()`);
await send('Emulation.clearDeviceMetricsOverride');

/* ---------------- 清空 ---------------- */

const cleared = await evalJS(`
  (() => {
    document.getElementById('clear').click();
    return {
      rows: document.querySelectorAll('.row').length,
      empty: !!document.querySelector('.rows .empty'),
      dlDisabled: document.getElementById('downloadAll').disabled,
      total: document.getElementById('nTotal').textContent,
    };
  })()
`);
console.log('\n=== 清空 ===');
console.log(`残留行 ${cleared.rows} · 空状态 ${cleared.empty} · 下载按钮禁用 ${cleared.dlDisabled} · 总数 ${cleared.total}`);
ok(cleared.rows === 0, '清空后仍有残留行');
ok(cleared.empty === true, '清空后缺少空状态提示');
ok(cleared.dlDisabled === true, '清空后下载按钮应禁用');
ok(cleared.total === '0', '清空后总数应为 0');

/* ---------------- 汇总 ---------------- */

console.log('\n=== 控制台错误 ===');
console.log(errors.length ? errors.join('\n') : '无');

console.log('\n=== 390px 窄屏 ===');
console.log(`视口 ${overflow.clientWidth}px · 页面内容宽 ${overflow.scrollWidth}px`);
console.log(`列表容器 ${overflow.rowsClientWidth}px · 列表内容宽 ${overflow.rowsScrollWidth}px`);
console.log(overflow.over.length ? `越界元素：\n  ${overflow.over.join('\n  ')}` : '无元素越过视口右边界');
ok(overflow.scrollWidth <= overflow.clientWidth + 1, `窄屏横向溢出 ${overflow.scrollWidth} > ${overflow.clientWidth}`);
ok(
  overflow.rowsScrollWidth <= overflow.rowsClientWidth + 1,
  `列表内部横向溢出 ${overflow.rowsScrollWidth} > ${overflow.rowsClientWidth}（会被 overflow:auto 藏起来）`
);

console.log('\n=== 结论 ===');
if (fails.length) {
  console.log('✗ 未通过：');
  for (const f of fails) console.log('  - ' + f);
} else {
  console.log('✓ 全部断言通过');
}
console.log(`截图：${join(SHOTS, 'image-shrink.png')}`);

ws.close();
chrome.kill();
process.exit(fails.length ? 1 : 0);
