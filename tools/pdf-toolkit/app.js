import { installNetCounter } from '../../assets/net-counter.js';
import { parseRanges, buildPlan } from '../../assets/pdf-range.js';
import { makeZip, uniqueName } from '../../assets/zip.js';

installNetCounter();

const $ = (id) => document.getElementById(id);
const els = {
  drop: $('drop'),
  pick: $('pick'),
  files: $('files'),
  rows: $('rows'),
  listTip: $('listTip'),
  modeSeg: $('modeSeg'),
  splitCtrl: $('splitCtrl'),
  splitMode: $('splitMode'),
  perCtrl: $('perCtrl'),
  per: $('per'),
  modeNote: $('modeNote'),
  nFiles: $('nFiles'),
  nPages: $('nPages'),
  nOut: $('nOut'),
  clear: $('clear'),
  run: $('run'),
  toast: $('toast'),
  engineSize: $('engineSize'),
};

const state = {
  items: [],
  mode: 'merge',
  splitMode: 'each',
  per: 2,
  busy: false,
  seq: 0,
};

/* ---------------- 工具函数 ---------------- */

const tick = () => new Promise((r) => setTimeout(r, 0));

function fmtSize(n) {
  if (!n && n !== 0) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(2) + ' MB';
}

let toastTimer = null;
function toast(msg, isError = false) {
  els.toast.textContent = msg;
  els.toast.classList.toggle('bad', !!isError);
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), isError ? 5200 : 3200);
}

function setStatus(text) {
  els.listTip.textContent = text || tipText();
}

function setBusy(busy) {
  state.busy = busy;
  els.run.disabled = busy || !state.items.some((it) => !it.error && it.pageCount);
  els.clear.disabled = busy || !state.items.length;
  els.run.textContent = busy ? '处理中…' : runLabel();
  els.drop.classList.toggle('busy', busy);
}

function runLabel() {
  return state.mode === 'merge' ? '生成并下载 PDF' : '拆分并打包下载';
}

function tipText() {
  if (!state.items.length) return '还没有文件';
  const ok = state.items.filter((it) => !it.error && it.pageCount);
  const reading = state.items.some((it) => !it.error && !it.pageCount);
  if (reading && !ok.length) return '正在读取…';
  return `${ok.length} 个可处理${state.items.length > ok.length ? `（${state.items.length - ok.length} 个有问题）` : ''}`;
}

/** 把库抛出的异常翻译成用户能懂的话 */
function describeError(e) {
  const name = (e && e.name) || '';
  const msg = (e && e.message) || String(e || '');
  const all = name + ' ' + msg;
  if (/encrypted|EncryptedPDF/i.test(all)) {
    return '这份 PDF 加了密码，本工具不处理加密文件';
  }
  if (/InvalidPDF|no pdf header|Failed to parse|Expected instance/i.test(all)) {
    return '不是有效的 PDF，文件可能已损坏';
  }
  if (/memory|allocation|out of bounds/i.test(all)) {
    return '内存不足，文件可能太大';
  }
  return '处理失败：' + msg.slice(0, 160);
}

/* ---------------- 加载引擎 ---------------- */

let LIB = null;

function reportEngineSize() {
  const el = els.engineSize;
  if (!el) return;
  const entry = performance
    .getEntriesByType('resource')
    .find((r) => /pdf-lib/.test(r.name));
  if (!entry) {
    el.textContent = '已加载';
    return;
  }
  const bytes = entry.encodedBodySize || entry.decodedBodySize || entry.transferSize || 0;
  el.textContent = bytes ? fmtSize(bytes) : '已加载';
}

/** pdf-lib 是懒加载的：打开页面不下载，第一次真正处理文件时才拉这 511KB */
async function loadLib() {
  if (LIB) return LIB;
  setStatus('正在加载 PDF 引擎（约 511 KB，只加载一次）…');
  LIB = await import('../../assets/vendor/pdf-lib.esm.min.js');
  reportEngineSize();
  return LIB;
}

/* ---------------- 文件进出 ---------------- */

async function addFiles(fileList) {
  const all = [...fileList];
  const pdfs = all.filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
  if (all.length > pdfs.length) {
    toast(`跳过了 ${all.length - pdfs.length} 个不是 PDF 的文件`, true);
  }
  if (!pdfs.length) return;

  const added = pdfs.map((f) => ({
    id: ++state.seq,
    file: f,
    name: f.name,
    size: f.size,
    range: '',
    rangeError: null,
    pages: [],
    pageCount: 0,
    error: null,
    doc: null,
  }));
  state.items.push(...added);
  render();

  for (const it of added) {
    try {
      const { PDFDocument } = await loadLib();
      const buf = await it.file.arrayBuffer();
      const doc = await PDFDocument.load(buf, { updateMetadata: false });
      it.doc = doc;
      it.pageCount = doc.getPageCount();
      it.pages = parseRanges('', it.pageCount).pages;
    } catch (e) {
      it.error = describeError(e);
    }
    render();
  }
}

function removeItem(id) {
  state.items = state.items.filter((it) => it.id !== id);
  render();
}

function moveItem(id, dir) {
  const i = state.items.findIndex((it) => it.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= state.items.length) return;
  const [it] = state.items.splice(i, 1);
  state.items.splice(j, 0, it);
  render();
}

/* ---------------- 渲染 ---------------- */

function paintMeta(el, it) {
  if (it.error) {
    el.textContent = it.error;
    el.classList.add('bad');
    return;
  }
  el.classList.remove('bad');
  if (!it.pageCount) {
    el.textContent = '正在读取…';
    return;
  }
  const parts = [`${it.pageCount} 页`, fmtSize(it.size),
    `选中 ${it.pages.length} 页`];
  if (it.rangeError) {
    el.textContent = it.rangeError;
    el.classList.add('bad');
    return;
  }
  el.textContent = parts.join(' · ');
}

function renderRow(it, index) {
  const row = document.createElement('div');
  row.className = 'pdfrow' + (it.error ? ' bad' : '');
  row.dataset.id = String(it.id);

  const badge = document.createElement('div');
  badge.className = 'pdfbadge';
  badge.textContent = it.error ? '!' : it.pageCount ? String(it.pageCount) : '…';
  badge.title = it.error ? it.error : '页数';
  row.appendChild(badge);

  const main = document.createElement('div');
  main.className = 'pdfmain';
  const name = document.createElement('div');
  name.className = 'pdfname';
  name.textContent = it.name;
  name.title = it.name;
  const meta = document.createElement('div');
  meta.className = 'pdfmeta';
  paintMeta(meta, it);
  main.append(name, meta);
  row.appendChild(main);

  const rangeWrap = document.createElement('label');
  rangeWrap.className = 'pdfrange';
  const range = document.createElement('input');
  range.type = 'text';
  range.value = it.range;
  range.placeholder = '全部页';
  range.setAttribute('aria-label', '页码范围');
  range.dataset.role = 'range';
  if (it.error || !it.pageCount) range.disabled = true;
  if (it.rangeError) range.classList.add('bad');
  rangeWrap.appendChild(range);
  row.appendChild(rangeWrap);

  const act = document.createElement('div');
  act.className = 'pdfact';
  const mk = (label, role, title, disabled) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn mini';
    b.textContent = label;
    b.dataset.act = role;
    b.title = title;
    b.disabled = !!disabled;
    return b;
  };
  act.append(
    mk('↑', 'up', '上移', index === 0),
    mk('↓', 'down', '下移', index === state.items.length - 1),
    mk('删', 'del', '移除这个文件')
  );
  row.appendChild(act);

  return row;
}

function render() {
  if (!state.items.length) {
    els.rows.innerHTML =
      '<div class="empty">还没有 PDF。拖进来以后，每一行右边可以填页码范围，比如 <code>1-3,5</code>。</div>';
  } else {
    els.rows.textContent = '';
    state.items.forEach((it, i) => els.rows.appendChild(renderRow(it, i)));
  }
  setStatus(null);
  updateStats();
  setBusy(state.busy);
}

function validItems() {
  return state.items.filter((it) => !it.error && it.pageCount > 0);
}

function currentPlan() {
  const valid = validItems();
  return buildPlan(
    valid.map((it) => ({ name: it.name, pages: it.pages })),
    { mode: state.mode, splitMode: state.splitMode, per: state.per }
  );
}

function updateStats() {
  const valid = validItems();
  els.nFiles.textContent = String(state.items.length);
  els.nPages.textContent = String(valid.reduce((s, it) => s + it.pages.length, 0));
  els.nOut.textContent = String(currentPlan().jobs.length);
}

/* ---------------- 生成 ---------------- */

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
}

/** 按文件分组复制页面，减少 copyPages 的调用次数 */
async function copyPagesInto(out, valid, parts) {
  const byItem = new Map();
  for (const pt of parts) {
    if (!byItem.has(pt.item)) byItem.set(pt.item, []);
    byItem.get(pt.item).push(pt.page);
  }
  for (const [idx, pages] of byItem) {
    const copied = await out.copyPages(valid[idx].doc, pages.map((p) => p - 1));
    copied.forEach((p) => out.addPage(p));
  }
}

async function run() {
  if (state.busy) return;

  const valid = validItems();
  if (!valid.length) {
    toast('先拖入至少一个 PDF', true);
    return;
  }
  const badRange = valid.find((it) => it.rangeError);
  if (badRange) {
    toast(`「${badRange.name}」页码范围有问题：${badRange.rangeError}`, true);
    return;
  }
  const noPage = valid.find((it) => !it.pages.length);
  if (noPage) {
    toast(`「${noPage.name}」没有选中任何页`, true);
    return;
  }

  const plan = currentPlan();
  if (plan.error) {
    toast(plan.error, true);
    return;
  }

  setBusy(true);
  try {
    const { PDFDocument } = await loadLib();

    if (state.mode === 'merge') {
      const job = plan.jobs[0];
      const out = await PDFDocument.create();
      setStatus(`正在合并 ${plan.totalPages} 页…`);
      await tick();
      await copyPagesInto(out, valid, job.parts);
      const bytes = await out.save();
      download(new Blob([bytes], { type: 'application/pdf' }), job.name);
      toast(`已生成 ${job.name}：${plan.totalPages} 页，${fmtSize(bytes.length)}`);
    } else {
      const entries = [];
      const used = new Set();
      let done = 0;
      for (const job of plan.jobs) {
        const out = await PDFDocument.create();
        await copyPagesInto(out, valid, job.parts);
        const bytes = await out.save();
        entries.push({ name: uniqueName(job.name, used), data: bytes });
        done += 1;
        if (done % 5 === 0 || done === plan.jobs.length) {
          setStatus(`正在拆分 ${done}/${plan.jobs.length}…`);
          await tick();
        }
      }
      const zip = makeZip(entries);
      const zipName = `拆分-${plan.jobs.length}个文件.zip`;
      download(new Blob([zip], { type: 'application/zip' }), zipName);
      toast(`已生成 ${plan.jobs.length} 个 PDF，打包为 ${fmtSize(zip.length)}`);
    }
  } catch (e) {
    console.error(e);
    toast(describeError(e), true);
  } finally {
    setBusy(false);
    setStatus(null);
  }
}

/* ---------------- 事件绑定 ---------------- */

els.pick.addEventListener('click', () => els.files.click());
els.files.addEventListener('change', () => {
  addFiles(els.files.files);
  els.files.value = '';
});

els.drop.addEventListener('click', (e) => {
  if (e.target.closest('button')) return;
  els.files.click();
});

['dragenter', 'dragover'].forEach((t) =>
  els.drop.addEventListener(t, (e) => {
    e.preventDefault();
    els.drop.classList.add('over');
  })
);
['dragleave', 'drop'].forEach((t) =>
  els.drop.addEventListener(t, (e) => {
    e.preventDefault();
    if (t === 'dragleave' && els.drop.contains(e.relatedTarget)) return;
    els.drop.classList.remove('over');
  })
);
els.drop.addEventListener('drop', (e) => {
  if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

els.rows.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const row = btn.closest('.pdfrow');
  if (!row) return;
  const id = Number(row.dataset.id);
  const act = btn.dataset.act;
  if (act === 'del') removeItem(id);
  else if (act === 'up') moveItem(id, -1);
  else if (act === 'down') moveItem(id, 1);
});

els.rows.addEventListener('input', (e) => {
  const inp = e.target.closest('input[data-role="range"]');
  if (!inp) return;
  const row = inp.closest('.pdfrow');
  const it = state.items.find((x) => x.id === Number(row.dataset.id));
  if (!it) return;
  it.range = inp.value;
  const r = parseRanges(it.range, it.pageCount);
  it.pages = r.pages;
  it.rangeError = r.error;
  inp.classList.toggle('bad', !!r.error);
  paintMeta(row.querySelector('.pdfmeta'), it);
  updateStats();
});

els.modeSeg.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-mode]');
  if (!btn) return;
  state.mode = btn.dataset.mode;
  syncMode();
});

els.splitMode.addEventListener('change', () => {
  state.splitMode = els.splitMode.value;
  syncMode();
});

els.per.addEventListener('input', () => {
  const n = Math.max(2, Math.min(200, Number(els.per.value) || 2));
  state.per = n;
  updateStats();
});

els.clear.addEventListener('click', () => {
  state.items = [];
  els.rows.textContent = '';
  render();
});

els.run.addEventListener('click', run);

function syncMode() {
  [...els.modeSeg.querySelectorAll('button')].forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode))
  );
  const isSplit = state.mode === 'split';
  els.splitCtrl.hidden = !isSplit;
  els.perCtrl.hidden = !isSplit || state.splitMode !== 'range';
  els.modeNote.textContent = isSplit
    ? '每个文件单独拆，结果装进一个 ZIP。文件之间不会混在一起。'
    : '所有文件按上面的顺序拼成一个 PDF。每个文件默认取全部页，填了页码就只取那些页。';
  els.run.textContent = runLabel();
  updateStats();
}

syncMode();
render();
