/**
 * PDF 工具的纯逻辑层：页码解析 + 产出计划
 *
 * 单独拆出来的原因：这两件事决定了「结果对不对」，
 * 但它们不需要 DOM、不需要 pdf-lib，所以可以直接在 Node 里跑单元测试。
 * 界面层只负责把用户输入喂进来、把计划执行出来。
 */

/** 把 "1-3,5" 这种输入解析成页码数组（1 起，去重、保持书写顺序） */
export function parseRanges(spec, total) {
  if (!Number.isInteger(total) || total < 1) {
    return { pages: [], error: '这个文件没有可用的页' };
  }

  const raw = String(spec == null ? '' : spec).trim();
  if (!raw) {
    const all = [];
    for (let i = 1; i <= total; i++) all.push(i);
    return { pages: all, error: null };
  }

  const tokens = raw.split(/[,，、;；\s]+/).filter(Boolean);
  if (!tokens.length) return { pages: [], error: '没有填页码' };

  const pages = [];
  for (const tk of tokens) {
    const range = /^(\d*)\s*[-~—–－]\s*(\d*)$/.exec(tk);

    if (range) {
      const a = range[1] === '' ? 1 : Number(range[1]);
      const b = range[2] === '' ? total : Number(range[2]);
      if (a < 1 || b < 1) return { pages: [], error: `「${tk}」页码从 1 开始` };
      if (a > b) return { pages: [], error: `「${tk}」起点比终点大` };
      if (b > total) return { pages: [], error: `「${tk}」超出总页数（共 ${total} 页）` };
      for (let i = a; i <= b; i++) pages.push(i);
      continue;
    }

    if (/^\d+$/.test(tk)) {
      const p = Number(tk);
      if (p < 1) return { pages: [], error: `页码从 1 开始，「${tk}」无效` };
      if (p > total) return { pages: [], error: `「${tk}」超出总页数（共 ${total} 页）` };
      pages.push(p);
      continue;
    }

    return { pages: [], error: `看不懂「${tk}」，请写成 1-3,5 这样的格式` };
  }

  const seen = new Set();
  const unique = [];
  for (const p of pages) {
    if (seen.has(p)) continue;
    seen.add(p);
    unique.push(p);
  }
  if (!unique.length) return { pages: [], error: '没有选中任何页' };
  return { pages: unique, error: null };
}

/** 去掉扩展名，用作输出文件的前缀 */
export function stem(name) {
  return String(name || 'PDF').replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]/g, '_');
}

export function chunk(list, size) {
  const n = Math.max(1, Number(size) || 1);
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

/** 页码范围显示成 "第 2-4 页" / "第 2,5 页" */
export function pagesLabel(pages) {
  if (!pages.length) return '无';
  if (pages.length === 1) return `第 ${pages[0]} 页`;
  const sorted = [...pages].sort((a, b) => a - b);
  const contiguous = sorted.every((p, i) => i === 0 || p === sorted[i - 1] + 1);
  if (contiguous) return `第 ${sorted[0]}-${sorted[sorted.length - 1]} 页`;
  if (sorted.length <= 4) return `第 ${sorted.join(', ')} 页`;
  return `第 ${sorted.slice(0, 3).join(', ')}… 共 ${sorted.length} 页`;
}

/**
 * 生成产出计划
 * @param {Array<{name:string, pages:number[]}>} items 已解析好页码的文件，顺序即合并顺序
 * @param {{mode:'merge'|'split', splitMode?:'each'|'range', per?:number}} opts
 * @returns {{jobs: Array<{name:string, parts:Array<{item:number, page:number}>}>, error:string|null, totalPages:number}}
 */
export function buildPlan(items, opts = {}) {
  const mode = opts.mode === 'split' ? 'split' : 'merge';
  const list = items.filter((it) => it && it.pages && it.pages.length);
  if (!list.length) return { jobs: [], error: '还没有选中任何页', totalPages: 0 };

  const totalPages = list.reduce((s, it) => s + it.pages.length, 0);

  if (mode === 'merge') {
    const parts = [];
    list.forEach((it, index) => {
      it.pages.forEach((page) => parts.push({ item: index, page }));
    });
    const name = list.length === 1 ? `${stem(list[0].name)}-已选页.pdf` : `合并-${list.length}个文件-${totalPages}页.pdf`;
    return { jobs: [{ name, parts }], error: null, totalPages };
  }

  // ---- 拆分 ----
  const splitMode = opts.splitMode === 'range' ? 'range' : 'each';
  const jobs = [];
  list.forEach((it, index) => {
    const base = stem(it.name);
    const groups = splitMode === 'range' ? chunk(it.pages, opts.per) : it.pages.map((p) => [p]);
    groups.forEach((group) => {
      const label =
        group.length === 1
          ? `第${group[0]}页`
          : `第${group[0]}-${group[group.length - 1]}页`;
      jobs.push({
        name: `${base}_${label}.pdf`,
        parts: group.map((page) => ({ item: index, page })),
      });
    });
  });
  return { jobs, error: null, totalPages };
}
