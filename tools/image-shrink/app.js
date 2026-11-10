/**
 * 本地图片压缩 —— 全流程在浏览器内完成，不发出任何网络请求。
 *
 * 技术栈全部是浏览器原生能力，没有任何第三方库：
 *   createImageBitmap  → 解码（顺带按 EXIF 摆正方向）
 *   OffscreenCanvas    → 缩放与重绘
 *   convertToBlob      → 按指定格式与质量编码
 *   makeZip            → 自己拼的 ZIP 容器，用于批量下载
 */
import { installNetCounter } from '../../assets/net-counter.js';
import { makeZip, uniqueName } from '../../assets/zip.js';

// 必须最先装，晚于任何可能的请求就没意义了
installNetCounter();

/* ================= DOM ================= */

const $ = (id) => document.getElementById(id);
const els = {
  drop: $('drop'),
  pick: $('pick'),
  files: $('files'),
  fmt: $('fmt'),
  maxEdge: $('maxEdge'),
  modeSeg: $('modeSeg'),
  qualityCtrl: $('qualityCtrl'),
  quality: $('quality'),
  qualityVal: $('qualityVal'),
  sizeCtrl: $('sizeCtrl'),
  targetKB: $('targetKB'),
  keepSmaller: $('keepSmaller'),
  fmtNote: $('fmtNote'),
  rows: $('rows'),
  listTip: $('listTip'),
  nTotal: $('nTotal'),
  sumIn: $('sumIn'),
  sumOut: $('sumOut'),
  sumSave: $('sumSave'),
  sumSaveWrap: $('sumSaveWrap'),
  clear: $('clear'),
  downloadAll: $('downloadAll'),
  toast: $('toast'),
};

/* ================= 状态 ================= */

const state = {
  items: [],        // 见 createItem
  seq: 0,
  running: false,
  dirty: false,     // 运行中改了配置，结束后要重跑
  config: {
    format: 'image/webp',
    maxEdge: 1920,
    mode: 'quality',
    quality: 0.8,
    targetBytes: 200 * 1024,
    keepSmaller: true,
  },
};

const rowEls = new Map();   // id -> 行 DOM

/* ================= 能力探测 ================= */

const SUPPORT = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 1;
  const out = {};
  for (const t of ['image/webp', 'image/jpeg', 'image/png', 'image/avif']) {
    try {
      out[t] = c.toDataURL(t).startsWith(`data:${t}`);
    } catch {
      out[t] = false;
    }
  }
  return out;
})();

const EXT = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/avif': 'avif' };
const TYPE_LABEL = { 'image/webp': 'WebP', 'image/jpeg': 'JPEG', 'image/png': 'PNG', 'image/avif': 'AVIF' };

/* ================= 工具函数 ================= */

function fmtBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1048576).toFixed(n < 10485760 ? 2 : 1)} MB`;
}

function stamp() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

let toastTimer = 0;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2200);
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 立刻 revoke 会让部分浏览器的下载中断，延后释放
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/* ================= 输出格式判定 ================= */

/**
 * 决定这张图最终编码成什么格式。
 * 选「保持原格式」时：webp/png/jpeg 原样保留；gif/bmp/avif 等统一转 WebP
 * （这些格式要么体积大、要么浏览器编码支持差，转 WebP 更实用）。
 */
function targetType(cfg, item) {
  if (cfg.format !== 'auto') return cfg.format;
  const t = (item.srcType || '').toLowerCase();
  if (t === 'image/jpeg' || t === 'image/png' || t === 'image/webp') return t;
  return SUPPORT['image/webp'] ? 'image/webp' : 'image/jpeg';
}

function extFor(type) {
  return EXT[type] || 'bin';
}

function outputName(item, type) {
  const base = item.name.replace(/\.[^.]+$/, '');
  return `${base}.${extFor(type)}`;
}

/* ================= 编码 ================= */

/**
 * 二分搜索质量参数，逼近但不超出目标体积。
 * 每次 convertToBlob 都是一次完整编码，所以迭代次数要克制。
 */
async function encodeToTarget(canvas, type, targetBytes) {
  const maxQ = await canvas.convertToBlob({ type, quality: 1 });
  if (maxQ.size <= targetBytes) return maxQ;

  const minQ = await canvas.convertToBlob({ type, quality: 0.05 });
  if (minQ.size > targetBytes) return minQ;   // 压不到目标，只能给最小

  let lo = 0.05;
  let hi = 1;
  let best = minQ;
  for (let i = 0; i < 6; i++) {
    const mid = (lo + hi) / 2;
    const blob = await canvas.convertToBlob({ type, quality: mid });
    if (blob.size <= targetBytes) {
      best = blob;
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return best;
}

function makeThumb(bitmap, size = 64) {
  // 居中裁成正方形。drawImage 是同步的，所以可以在 bitmap.close() 之前完成
  const s = Math.min(bitmap.width, bitmap.height);
  const sx = (bitmap.width - s) / 2;
  const sy = (bitmap.height - s) / 2;
  const c = new OffscreenCanvas(size, size);
  const g = c.getContext('2d');
  g.drawImage(bitmap, sx, sy, s, s, 0, 0, size, size);
  return c.convertToBlob({ type: 'image/webp', quality: 0.7 }).then((b) => URL.createObjectURL(b));
}

/* ================= 单张处理 ================= */

function createItem(file) {
  return {
    id: ++state.seq,
    file,
    name: file.name,
    srcType: file.type,
    srcSize: file.size,
    srcW: 0,
    srcH: 0,
    outBlob: null,
    outType: '',
    outSize: 0,
    outW: 0,
    outH: 0,
    outName: '',
    thumb: '',
    keptOriginal: false,
    note: '',
    status: 'pending',   // pending | working | done | error
    error: '',
  };
}

function releaseItem(item) {
  if (item.thumb) { URL.revokeObjectURL(item.thumb); item.thumb = ''; }
  item.outBlob = null;
  item.outSize = 0;
  item.note = '';
  item.keptOriginal = false;
  item.error = '';
}

async function processOne(item) {
  const cfg = state.config;
  item.status = 'working';
  updateRow(item);

  try {
    let bitmap;
    try {
      bitmap = await createImageBitmap(item.file, { imageOrientation: 'from-image' });
    } catch {
      throw new Error('浏览器无法解码此格式（HEIC 需先转成 JPG）');
    }

    item.srcW = bitmap.width;
    item.srcH = bitmap.height;

    // 目标尺寸
    let tw = bitmap.width;
    let th = bitmap.height;
    const max = cfg.maxEdge;
    if (max > 0 && Math.max(tw, th) > max) {
      const scale = max / Math.max(tw, th);
      tw = Math.max(1, Math.round(tw * scale));
      th = Math.max(1, Math.round(th * scale));
    }

    const type = targetType(cfg, item);
    const thumbPromise = makeThumb(bitmap);

    const canvas = new OffscreenCanvas(tw, th);
    const ctx = canvas.getContext('2d', { alpha: type !== 'image/jpeg' });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (type === 'image/jpeg') {
      // JPEG 无透明通道，不铺底的话透明区会变黑
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, tw, th);
    }
    ctx.drawImage(bitmap, 0, 0, tw, th);
    item.thumb = await thumbPromise;
    bitmap.close();

    let blob;
    let note = '';

    if (type === 'image/png' || cfg.mode === 'quality') {
      blob = await canvas.convertToBlob({ type, quality: cfg.quality });
      if (type === 'image/png' && cfg.mode === 'size') {
        note = 'PNG 无损，目标大小对它无效';
      }
    } else if (item.srcSize <= cfg.targetBytes) {
      // 原图本来就在目标体积以内。这时候去「逼近目标」只会把文件放大到接近目标值
      // （16KB 的图被压成 55KB），对一个压缩工具来说是错的。
      // 改成按质量设置压一次，更小才采用，由下面的保留逻辑兜底。
      blob = await canvas.convertToBlob({ type, quality: cfg.quality });
      note = '原图已在目标体积内';
    } else {
      blob = await encodeToTarget(canvas, type, cfg.targetBytes);
    }

    if (cfg.keepSmaller && blob.size >= item.srcSize) {
      // 压不动就别硬压：保留原图，避免"压缩后更大"这种荒唐结果
      item.outBlob = item.file;
      item.outType = item.srcType || 'image/jpeg';
      item.outSize = item.file.size;
      item.outW = item.srcW;
      item.outH = item.srcH;
      item.keptOriginal = true;
      note = '原图更小，保留原文件';
    } else {
      item.outBlob = blob;
      item.outType = type;
      item.outSize = blob.size;
      item.outW = tw;
      item.outH = th;
      item.keptOriginal = false;
    }

    item.outName = outputName(item, item.outType);
    item.note = note;
    item.status = 'done';
  } catch (err) {
    item.status = 'error';
    item.error = err && err.message ? err.message : String(err);
  }

  updateRow(item);
  updateSummary();
}

async function processAll() {
  if (state.running) {
    state.dirty = true;
    return;
  }
  state.running = true;
  try {
    // 串行处理：同时解多张大图很容易把内存顶爆，而串行的总耗时并不差
    for (const item of state.items) {
      if (item.status === 'done') continue;
      await processOne(item);
    }
  } finally {
    state.running = false;
    if (state.dirty) {
      state.dirty = false;
      // 配置在处理途中被改了，重来一遍
      for (const item of state.items) { releaseItem(item); item.status = 'pending'; }
      renderList();
      processAll();
    }
  }
}

/* ================= 渲染 ================= */

function buildRow(item) {
  const el = document.createElement('div');
  el.className = 'row';
  el.dataset.id = String(item.id);

  const thumb = document.createElement('div');
  thumb.className = 'thumb';

  const main = document.createElement('div');
  main.className = 'rowmain';
  const name = document.createElement('div');
  name.className = 'rowname';
  const meta = document.createElement('div');
  meta.className = 'rowmeta';
  main.append(name, meta);

  const sizes = document.createElement('div');
  sizes.className = 'rowsizes';

  const save = document.createElement('div');
  save.className = 'rowsave';

  const act = document.createElement('div');
  act.className = 'rowact';

  el.append(thumb, main, sizes, save, act);

  el._refs = { thumb, name, meta, sizes, save, act };
  return el;
}

function updateRow(item) {
  let el = rowEls.get(item.id);
  if (!el) {
    el = buildRow(item);
    rowEls.set(item.id, el);
    els.rows.appendChild(el);
  }
  const r = el._refs;

  el.className = `row is-${item.status}`;

  if (item.thumb) {
    r.thumb.style.backgroundImage = `url("${item.thumb}")`;
    r.thumb.classList.add('has');
  }

  r.name.textContent = item.name;
  r.name.title = item.name;

  // 第二行：尺寸与格式
  if (item.status === 'error') {
    r.meta.textContent = item.error;
    r.meta.className = 'rowmeta err';
  } else if (item.srcW) {
    const from = `${item.srcW}×${item.srcH}`;
    const to = item.outW && (item.outW !== item.srcW || item.outH !== item.srcH)
      ? ` → ${item.outW}×${item.outH}`
      : '';
    const typeLabel = item.outType ? TYPE_LABEL[item.outType] || '' : '';
    r.meta.textContent = `${from}${to}${typeLabel ? ' · ' + typeLabel : ''}${item.note ? ' · ' + item.note : ''}`;
    r.meta.className = 'rowmeta';
  } else {
    r.meta.textContent = item.status === 'working' ? '处理中…' : `${fmtBytes(item.srcSize)} · 等待处理`;
    r.meta.className = 'rowmeta';
  }

  // 体积对比
  if (item.status === 'done') {
    r.sizes.innerHTML = `<span class="from">${fmtBytes(item.srcSize)}</span>`
      + `<span class="arrow">→</span>`
      + `<span class="to">${fmtBytes(item.outSize)}</span>`;
    const pct = item.srcSize ? Math.round((1 - item.outSize / item.srcSize) * 100) : 0;
    if (pct > 0) {
      r.save.textContent = `-${pct}%`;
      r.save.className = 'rowsave good';
    } else if (pct === 0) {
      r.save.textContent = '持平';
      r.save.className = 'rowsave';
    } else {
      r.save.textContent = `+${-pct}%`;
      r.save.className = 'rowsave bad';
    }
    r.act.innerHTML = '';
    const a = document.createElement('a');
    a.className = 'btn mini';
    a.textContent = '下载';
    a.download = item.outName;
    a.href = URL.createObjectURL(item.outBlob);
    a.addEventListener('click', () => setTimeout(() => URL.revokeObjectURL(a.href), 60000));
    r.act.appendChild(a);
  } else if (item.status === 'working') {
    r.sizes.textContent = '';
    r.save.textContent = '···';
    r.save.className = 'rowsave';
    r.act.innerHTML = '';
  } else if (item.status === 'error') {
    r.sizes.textContent = fmtBytes(item.srcSize);
    r.save.textContent = '失败';
    r.save.className = 'rowsave bad';
    r.act.innerHTML = '';
  } else {
    r.sizes.textContent = fmtBytes(item.srcSize);
    r.save.textContent = '';
    r.save.className = 'rowsave';
    r.act.innerHTML = '';
  }
}

function renderList() {
  rowEls.clear();
  els.rows.innerHTML = '';
  if (!state.items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '还没有图片。拖进来就自动开始处理。';
    els.rows.appendChild(empty);
    updateSummary();
    return;
  }
  for (const item of state.items) {
    const el = buildRow(item);
    rowEls.set(item.id, el);
    els.rows.appendChild(el);
    updateRow(item);
  }
  updateSummary();
}

function updateSummary() {
  const n = state.items.length;
  const done = state.items.filter((i) => i.status === 'done');
  const sumIn = done.reduce((s, i) => s + i.srcSize, 0);
  const sumOut = done.reduce((s, i) => s + i.outSize, 0);

  els.nTotal.textContent = String(n);
  els.sumIn.textContent = fmtBytes(sumIn);
  els.sumOut.textContent = fmtBytes(sumOut);

  if (sumIn > 0) {
    const pct = Math.round((1 - sumOut / sumIn) * 100);
    els.sumSave.textContent = `${fmtBytes(Math.max(0, sumIn - sumOut))}（${pct}%）`;
    els.sumSave.className = pct > 0 ? 'good' : 'bad';
  } else {
    els.sumSave.textContent = '0 B';
    els.sumSave.className = '';
  }

  if (n === 0) {
    els.listTip.textContent = '还没有图片';
  } else if (done.length === n) {
    els.listTip.textContent = `${n} 张全部处理完成`;
  } else {
    els.listTip.textContent = `${done.length} / ${n} 处理完成`;
  }

  els.clear.disabled = n === 0;
  els.downloadAll.disabled = done.length === 0;
  els.downloadAll.textContent = done.length > 1 ? `全部下载（ZIP）` : '下载';
}

/* ================= 增删 ================= */

function addFiles(fileList) {
  const incoming = [...fileList];
  const before = state.items.length;
  for (const file of incoming) {
    const looksImage = /^image\//i.test(file.type) || /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif)$/i.test(file.name);
    if (!looksImage) continue;
    if (state.items.some((i) => i.name === file.name && i.srcSize === file.size)) continue; // 去重
    state.items.push(createItem(file));
  }
  const added = state.items.length - before;
  if (!added) {
    toast(incoming.length ? '这些图片已经在列表里了' : '没有识别到图片文件');
    return;
  }
  renderList();
  processAll();
}

/* ================= 事件绑定 ================= */

els.pick.addEventListener('click', () => els.files.click());
els.files.addEventListener('change', () => {
  addFiles(els.files.files);
  els.files.value = '';   // 允许重复选同一批文件
});

// 拖拽
['dragenter', 'dragover'].forEach((ev) => {
  els.drop.addEventListener(ev, (e) => {
    e.preventDefault();
    els.drop.classList.add('over');
  });
});
['dragleave', 'drop'].forEach((ev) => {
  els.drop.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === 'dragleave' && els.drop.contains(e.relatedTarget)) return;
    els.drop.classList.remove('over');
  });
});
els.drop.addEventListener('drop', (e) => {
  if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
});

// 整页也接住拖放，避免浏览器直接打开图片把页面顶掉
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

/* --- 配置 --- */

function readConfig() {
  state.config.format = els.fmt.value;
  state.config.maxEdge = Number(els.maxEdge.value);
  state.config.quality = Number(els.quality.value) / 100;
  state.config.keepSmaller = els.keepSmaller.checked;
  const kb = Number(els.targetKB.value);
  state.config.targetBytes = Math.max(10, Number.isFinite(kb) ? kb : 200) * 1024;
}

function reprocess() {
  readConfig();
  refreshFmtNote();
  if (!state.items.length) return;
  for (const item of state.items) {
    releaseItem(item);
    item.status = 'pending';
  }
  renderList();
  processAll();
}

function refreshFmtNote() {
  const fmt = els.fmt.value;
  const mode = state.config.mode;
  if (fmt === 'image/png' && mode === 'size') {
    els.fmtNote.textContent = 'PNG 是无损格式，按目标大小对它无效';
    els.fmtNote.className = 'srow-note warn';
  } else if (fmt === 'image/jpeg') {
    els.fmtNote.textContent = 'JPEG 无透明通道，透明区域会填白';
    els.fmtNote.className = 'srow-note';
  } else {
    els.fmtNote.textContent = '';
    els.fmtNote.className = 'srow-note';
  }
}

els.fmt.addEventListener('change', () => {
  if (els.fmt.value === 'auto' && !SUPPORT['image/webp']) {
    toast('此浏览器不支持 WebP 编码，将退回 JPEG');
  }
  reprocess();
});
els.maxEdge.addEventListener('change', reprocess);
els.keepSmaller.addEventListener('change', reprocess);

els.quality.addEventListener('input', () => {
  els.qualityVal.textContent = els.quality.value;
});
els.quality.addEventListener('change', reprocess);

els.targetKB.addEventListener('change', reprocess);

els.modeSeg.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-mode]');
  if (!btn) return;
  state.config.mode = btn.dataset.mode;
  for (const b of els.modeSeg.querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b === btn));
  }
  els.qualityCtrl.hidden = state.config.mode !== 'quality';
  els.sizeCtrl.hidden = state.config.mode !== 'size';
  reprocess();
});

els.clear.addEventListener('click', () => {
  for (const item of state.items) releaseItem(item);
  state.items = [];
  renderList();
  els.files.value = '';
});

els.downloadAll.addEventListener('click', async () => {
  const done = state.items.filter((i) => i.status === 'done' && i.outBlob);
  if (!done.length) return;

  if (done.length === 1) {
    saveBlob(done[0].outBlob, done[0].outName);
    toast('已开始下载');
    return;
  }

  els.downloadAll.disabled = true;
  const label = els.downloadAll.textContent;
  els.downloadAll.textContent = '打包中…';
  try {
    const used = new Set();
    const entries = [];
    for (const item of done) {
      const data = new Uint8Array(await item.outBlob.arrayBuffer());
      entries.push({ name: uniqueName(item.outName, used), data });
    }
    const zip = makeZip(entries);
    saveBlob(new Blob([zip], { type: 'application/zip' }), `压缩图片-${stamp()}.zip`);
    toast(`已打包 ${done.length} 张`);
  } catch (err) {
    toast('打包失败：' + (err.message || err));
  } finally {
    els.downloadAll.textContent = label;
    els.downloadAll.disabled = false;
  }
});

/* ================= 启动 ================= */

// 不支持的格式直接从下拉里去掉，别让用户选了之后才报错
for (const opt of [...els.fmt.options]) {
  const v = opt.value;
  if (v !== 'auto' && !SUPPORT[v]) {
    opt.disabled = true;
    opt.textContent = `${opt.textContent}（此浏览器不支持）`;
  }
}

readConfig();
refreshFmtNote();
updateSummary();
