/**
 * 本地脱敏工具 —— 前端逻辑
 * 全流程无网络请求；此处主动接管 fetch / XHR 只为把「请求数」显示出来。
 */
import {
  detect,
  applyMask,
  summarize,
  buildMapping,
  restore,
  mappingToCSV,
  parseMappingCSV,
  RULES,
  DEFAULT_ENABLED,
} from '../../assets/pii-rules.js';

/* ================= 网络请求计数（必须最先执行） ================= */
const net = { count: 0 };
(function hookNetwork() {
  const bump = () => {
    net.count += 1;
    const el = document.getElementById('netCount');
    if (el) el.textContent = String(net.count);
  };
  const realFetch = window.fetch;
  if (realFetch) {
    window.fetch = function (...args) {
      bump();
      return realFetch.apply(this, args);
    };
  }
  const RealXHR = window.XMLHttpRequest;
  if (RealXHR) {
    const open = RealXHR.prototype.open;
    RealXHR.prototype.open = function (...args) {
      bump();
      return open.apply(this, args);
    };
  }
  if (navigator.sendBeacon) {
    const realBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (...args) {
      bump();
      return realBeacon(...args);
    };
  }
  if (window.WebSocket) {
    const RealWS = window.WebSocket;
    window.WebSocket = function (...args) {
      bump();
      return new RealWS(...args);
    };
    window.WebSocket.prototype = RealWS.prototype;
  }
})();

/* ================= DOM ================= */
const $ = (id) => document.getElementById(id);
const els = {
  input: $('input'),
  preview: $('preview'),
  output: $('output'),
  counter: $('counter'),
  outCount: $('outCount'),
  stats: $('stats'),
  rulesPanel: $('rulesPanel'),
  modeSeg: $('modeSeg'),
  toggleRules: $('toggleRules'),
  clearBtn: $('clearBtn'),
  copyBtn: $('copyBtn'),
  downloadBtn: $('downloadBtn'),
  toast: $('toast'),
  netCount: $('netCount'),
  // 映射表
  mapBox: $('mapBox'),
  mapCount: $('mapCount'),
  mapHint: $('mapHint'),
  mapTable: $('mapTable'),
  mapCopyBtn: $('mapCopyBtn'),
  mapDownloadBtn: $('mapDownloadBtn'),
  // 页签
  tabs: $('tabs'),
  tabMask: $('tab-mask'),
  tabRestore: $('tab-restore'),
  // 还原
  restoreIn: $('restoreIn'),
  restoreOut: $('restoreOut'),
  restoreBtn: $('restoreBtn'),
  restoreCopyBtn: $('restoreCopyBtn'),
  restoreInfo: $('restoreInfo'),
  restoreStat: $('restoreStat'),
  restoreSrc: $('restoreSrc'),
  loadCsvBtn: $('loadCsvBtn'),
  toMaskBtn: $('toMaskBtn'),
  csvFile: $('csvFile'),
};

/* ================= 状态 ================= */
const state = {
  mode: 'partial',
  enabled: new Set(DEFAULT_ENABLED),
  skipped: new Set(),
  findings: [],
  mapping: [],
  output: '',
  importedMapping: null, // 用户导入的 CSV 映射表，优先于内存中的
  restoreText: '',
};

/* ================= 工具函数 ================= */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

let toastTimer;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2000);
}

function stamp() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
}

function download(filename, content, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function copyText(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg);
  } catch {
    toast('复制失败，请手动选中复制');
  }
}

/* ================= 规则面板 ================= */
function buildRules() {
  const frag = document.createDocumentFragment();
  for (const r of RULES) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.enabled.has(r.id);
    cb.value = r.id;
    cb.addEventListener('change', () => {
      if (cb.checked) state.enabled.add(r.id);
      else state.enabled.delete(r.id);
      run();
    });
    label.appendChild(cb);
    label.appendChild(document.createTextNode(r.label));
    if (r.severity === 'high') label.style.fontWeight = '600';
    frag.appendChild(label);
  }
  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.textContent =
    '「机构名称（泛匹配）」误报偏多（任何带「公司／银行／医院」后缀的短语都会命中），默认关闭；「单位名称（字段触发）」靠「开票抬头／开户行」这类字段名命中，准确度高，默认开启。';
  frag.appendChild(hint);
  els.rulesPanel.appendChild(frag);
}

/* ================= 脱敏流程 ================= */
function run() {
  const text = els.input.value;
  const findings = detect(text, { enabled: [...state.enabled] });
  state.findings = findings;

  const alive = new Set(findings.map((f) => f.key));
  for (const k of [...state.skipped]) if (!alive.has(k)) state.skipped.delete(k);

  state.mapping = buildMapping(findings);

  renderPreview(text, findings);

  const masked = findings.length
    ? applyMask(text, findings, { mode: state.mode, skipped: state.skipped })
    : text;
  state.output = masked;
  els.output.value = masked;

  const hidden = findings.filter((f) => !state.skipped.has(f.key)).length;
  els.counter.innerHTML = `已识别 <b>${findings.length}</b> 处 · 遮盖 <b>${hidden}</b> 处`;
  els.outCount.textContent = findings.length ? `${masked.length} 字` : '';

  renderStats(findings);
  renderMap();

  const hasText = text.trim().length > 0;
  els.copyBtn.disabled = !hasText;
  els.downloadBtn.disabled = !hasText;

  // 若当前在还原页签，映射表变了要同步
  if (!els.tabRestore.hidden) syncRestoreSource();
}

function renderPreview(text, findings) {
  if (!text) {
    els.preview.innerHTML = '<span class="empty">识别结果会显示在这里</span>';
    return;
  }
  if (!findings.length) {
    els.preview.innerHTML =
      `<span class="empty">没有识别到敏感信息。如果内容里确实有，可能是姓名缺少「姓名：」这类前缀，可在「识别项」里打开更多规则。</span>\n\n` +
      escapeHtml(text.slice(0, 4000));
    return;
  }

  let html = '';
  let cursor = 0;
  for (const f of findings) {
    if (f.start < cursor) continue;
    if (f.start > cursor) html += escapeHtml(text.slice(cursor, f.start));
    const keep = state.skipped.has(f.key);
    const cls = ['hit', keep ? 'keep' : '', f.valid ? '' : 'invalid'].filter(Boolean).join(' ');
    const title = `${f.label}${f.valid ? '' : '（未通过校验，建议人工确认）'} — 点击${keep ? '遮盖' : '保留'}`;
    html += `<mark class="${cls}" data-key="${escapeHtml(f.key)}" title="${escapeHtml(title)}">${escapeHtml(f.raw)}</mark>`;
    cursor = f.end;
  }
  if (cursor < text.length) html += escapeHtml(text.slice(cursor));
  els.preview.innerHTML = html;
}

function renderStats(findings) {
  els.stats.innerHTML = findings.length
    ? summarize(findings)
        .map((s) => `<span class="chip">${escapeHtml(s.label)} × ${s.count}</span>`)
        .join('')
    : '';
}

function renderMap() {
  const mapping = state.mapping;
  const isToken = state.mode === 'token';

  els.mapCount.textContent = mapping.length ? `共 ${mapping.length} 条` : '';
  els.mapHint.textContent = !mapping.length
    ? ''
    : isToken
      ? '可直接下载保存，之后用「还原」页签对回来'
      : '当前是「部分保留／完全遮盖」，不可还原；切到「占位符」才能生成可还原的映射表';

  if (!mapping.length) {
    els.mapTable.innerHTML = '<div class="emptyrow">还没有识别到敏感信息。</div>';
    return;
  }

  const rows = mapping
    .map(
      (m) => `<tr>
        <td class="tok">${escapeHtml(m.token)}</td>
        <td>${escapeHtml(m.type)}</td>
        <td>${escapeHtml(m.value)}</td>
        <td class="num">${m.count}</td>
      </tr>`
    )
    .join('');

  els.mapTable.innerHTML = `<table>
    <thead><tr><th>占位符</th><th>类型</th><th>原文</th><th>次数</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/* ================= 页签 ================= */
function switchTab(name) {
  const isMask = name === 'mask';
  els.tabMask.hidden = !isMask;
  els.tabRestore.hidden = isMask;
  [...els.tabs.querySelectorAll('button')].forEach((b) =>
    b.setAttribute('aria-selected', String(b.dataset.tab === name))
  );

  if (!isMask) {
    syncRestoreSource();
    // 首次进入且输入为空时，把当前脱敏结果带过来，方便立刻验证还原是否有效
    if (!els.restoreIn.value && state.output && state.mode === 'token') {
      els.restoreIn.value = state.output;
      doRestore();
      toast('已填入当前脱敏结果，可直接核对还原效果');
    }
  }
}

/* ================= 还原 ================= */
function activeMapping() {
  return state.importedMapping?.length ? state.importedMapping : state.mapping;
}

function syncRestoreSource() {
  const m = activeMapping();
  const src = state.importedMapping?.length ? '导入的 CSV' : '本页生成的';
  els.restoreSrc.textContent = `当前映射表：${m.length} 条（${src}）`;
  if (!els.restoreIn.value) doRestore();
}

let restoreTimer;
function scheduleRestore() {
  clearTimeout(restoreTimer);
  restoreTimer = setTimeout(doRestore, 200);
}

function doRestore() {
  const text = els.restoreIn.value;
  const mapping = activeMapping();

  if (!text.trim()) {
    els.restoreOut.innerHTML = '<span class="empty">还原结果会显示在这里</span>';
    els.restoreStat.textContent = '';
    els.restoreInfo.textContent = '';
    return;
  }
  if (!mapping.length) {
    els.restoreOut.innerHTML =
      '<span class="empty">没有可用的映射表。先在上面「脱敏」页签用「占位符」方式生成一份，或点右上角导入之前下载的 CSV。</span>';
    els.restoreStat.textContent = '';
    els.restoreInfo.textContent = '';
    return;
  }

  const r = restore(text, mapping);
  state.restoreText = r.text;

  els.restoreOut.textContent = r.text;
  els.restoreOut.style.whiteSpace = 'pre-wrap';

  const stat = r.missing
    ? `已还原 ${r.restored} 处 · 还有 ${r.missing} 处没匹配上`
    : `已还原 ${r.restored} 处`;
  els.restoreStat.textContent = stat;
  els.restoreInfo.textContent = r.missing
    ? '有占位符没匹配上，可能是映射表不全，或者对方改动了编号'
    : '';
}

function loadCsv(text) {
  const parsed = parseMappingCSV(text);
  if (!parsed.length) {
    toast('没读出内容，请确认是导出的映射表 CSV');
    return;
  }
  state.importedMapping = parsed;
  syncRestoreSource();
  doRestore();
  toast(`已导入 ${parsed.length} 条映射`);
}

/* ================= 事件 ================= */

// 页签
els.tabs.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (btn) switchTab(btn.dataset.tab);
});
els.toMaskBtn.addEventListener('click', () => switchTab('mask'));

// 点击高亮切换遮盖 / 保留
els.preview.addEventListener('click', (e) => {
  const mark = e.target.closest('mark.hit');
  if (!mark) return;
  const key = mark.dataset.key;
  if (state.skipped.has(key)) state.skipped.delete(key);
  else state.skipped.add(key);
  run();
});

// 模式切换
els.modeSeg.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-mode]');
  if (!btn) return;
  state.mode = btn.dataset.mode;
  [...els.modeSeg.querySelectorAll('button')].forEach((b) =>
    b.setAttribute('aria-pressed', String(b === btn))
  );
  run();
});

els.toggleRules.addEventListener('click', () => els.rulesPanel.classList.toggle('open'));

let inputTimer;
els.input.addEventListener('input', () => {
  clearTimeout(inputTimer);
  inputTimer = setTimeout(run, 160);
});

els.clearBtn.addEventListener('click', () => {
  els.input.value = '';
  state.skipped.clear();
  run();
  els.input.focus();
});

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

本月结算金额 42000 元，共 35 件商品，签字页见第 8 页。

甲方指定联系人张伟负责后续对接，张伟的联系电话同上。`;

$('sampleBtn').addEventListener('click', () => {
  els.input.value = SAMPLE;
  state.skipped.clear();
  run();
});

els.copyBtn.addEventListener('click', () => {
  if (state.output) copyText(state.output, '已复制脱敏结果');
});

els.downloadBtn.addEventListener('click', () => {
  if (!state.output) return;
  const suffix = state.mode === 'token' ? '可还原' : '';
  download(`已脱敏${suffix}-${stamp()}.txt`, state.output);
  toast('已下载');
});

// 映射表
els.mapCopyBtn.addEventListener('click', () => {
  if (!state.mapping.length) return;
  copyText(mappingToCSV(state.mapping), '已复制映射表 CSV');
});

els.mapDownloadBtn.addEventListener('click', () => {
  if (!state.mapping.length) return;
  download(`映射表-${stamp()}.csv`, mappingToCSV(state.mapping), 'text/csv;charset=utf-8');
  toast('已下载映射表，请自行保管');
});

// 还原
els.restoreIn.addEventListener('input', scheduleRestore);
els.restoreBtn.addEventListener('click', doRestore);
els.restoreCopyBtn.addEventListener('click', () => {
  if (state.restoreText) copyText(state.restoreText, '已复制还原结果');
});
els.loadCsvBtn.addEventListener('click', () => els.csvFile.click());
els.csvFile.addEventListener('change', () => {
  const file = els.csvFile.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => loadCsv(String(reader.result || ''));
  reader.readAsText(file, 'utf-8');
  els.csvFile.value = '';
});

// 拖拽文件
function readFile(file) {
  if (file.size > 8 * 1024 * 1024) {
    toast('文件超过 8MB，建议分段处理');
    return;
  }
  if (/\.csv$/i.test(file.name)) {
    const reader = new FileReader();
    reader.onload = () => loadCsv(String(reader.result || ''));
    reader.readAsText(file, 'utf-8');
    return;
  }
  if (!/\.(txt|md|csv|json|log)$/i.test(file.name)) {
    toast('目前只支持纯文本类文件（.txt / .md / .csv / .json）');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    els.input.value = String(reader.result || '');
    state.skipped.clear();
    switchTab('mask');
    run();
  };
  reader.readAsText(file, 'utf-8');
}

['dragover', 'dragenter'].forEach((ev) => document.addEventListener(ev, (e) => e.preventDefault()));
document.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (file) readFile(file);
});

/* ================= 启动 ================= */
buildRules();
run();
els.netCount.textContent = String(net.count);
