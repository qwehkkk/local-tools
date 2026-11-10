import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRanges, buildPlan, stem, chunk, pagesLabel } from '../assets/pdf-range.js';

/* ---------------- 页码解析 ---------------- */

test('空输入表示整份文件', () => {
  assert.deepEqual(parseRanges('', 4).pages, [1, 2, 3, 4]);
  assert.deepEqual(parseRanges('   ', 2).pages, [1, 2]);
});

test('单页与连续区间', () => {
  assert.deepEqual(parseRanges('3', 10).pages, [3]);
  assert.deepEqual(parseRanges('2-5', 10).pages, [2, 3, 4, 5]);
  assert.deepEqual(parseRanges('5-5', 10).pages, [5]);
});

test('开区间：5- 到末尾，-3 从头开始', () => {
  assert.deepEqual(parseRanges('5-', 10).pages, [5, 6, 7, 8, 9, 10]);
  assert.deepEqual(parseRanges('-3', 10).pages, [1, 2, 3]);
  assert.deepEqual(parseRanges('-', 3).pages, [1, 2, 3]);
});

test('混合书写与去重，保持顺序', () => {
  assert.deepEqual(parseRanges('1,3-4,2', 10).pages, [1, 3, 4, 2]);
  assert.deepEqual(parseRanges('3,3,1', 10).pages, [3, 1]);
  assert.deepEqual(parseRanges('1，2、3；4', 10).pages, [1, 2, 3, 4]);
});

test('超出总页数要报错并说明总数', () => {
  const r = parseRanges('11', 10);
  assert.equal(r.pages.length, 0);
  assert.match(r.error, /超出总页数/);
  assert.match(r.error, /10/);
  assert.match(parseRanges('8-12', 10).error, /超出/);
});

test('起点终点颠倒、0 页、乱写都要报错', () => {
  assert.match(parseRanges('5-2', 10).error, /起点比终点大/);
  assert.match(parseRanges('0', 10).error, /从 1 开始/);
  assert.match(parseRanges('abc', 10).error, /看不懂/);
  assert.match(parseRanges('1-2-x', 10).error, /看不懂/);
});

test('空文件不能解析出页码', () => {
  const r = parseRanges('', 0);
  assert.equal(r.pages.length, 0);
  assert.ok(r.error);
});

/* ---------------- 产出计划 ---------------- */

const ITEMS = [
  { name: '合同.pdf', pages: [1, 3] },
  { name: '附件.pdf', pages: [2] },
];

test('合并模式：按文件顺序拼页，命名体现规模', () => {
  const p = buildPlan(ITEMS, { mode: 'merge' });
  assert.equal(p.error, null);
  assert.equal(p.jobs.length, 1);
  assert.equal(p.totalPages, 3);
  assert.deepEqual(p.jobs[0].parts, [
    { item: 0, page: 1 },
    { item: 0, page: 3 },
    { item: 1, page: 2 },
  ]);
  assert.equal(p.jobs[0].name, '合并-2个文件-3页.pdf');
});

test('单个文件合并时用文件名做输出名', () => {
  const p = buildPlan([ITEMS[0]], { mode: 'merge' });
  assert.equal(p.jobs[0].name, '合同-已选页.pdf');
});

test('拆分模式：每页一个文件', () => {
  const p = buildPlan(ITEMS, { mode: 'split', splitMode: 'each' });
  assert.equal(p.jobs.length, 3);
  assert.deepEqual(
    p.jobs.map((j) => j.name),
    ['合同_第1页.pdf', '合同_第3页.pdf', '附件_第2页.pdf']
  );
  assert.ok(p.jobs.every((j) => j.parts.length === 1));
});

test('拆分模式：每 N 页一份，跨文件不会混在一起', () => {
  const p = buildPlan(
    [
      { name: 'a.pdf', pages: [1, 2, 3, 4, 5] },
      { name: 'b.pdf', pages: [1, 2] },
    ],
    { mode: 'split', splitMode: 'range', per: 2 }
  );
  assert.deepEqual(
    p.jobs.map((j) => j.name),
    ['a_第1-2页.pdf', 'a_第3-4页.pdf', 'a_第5页.pdf', 'b_第1-2页.pdf']
  );
  assert.equal(p.jobs[2].parts.length, 1);
});

test('没有选中任何页时给出错误而不是空计划', () => {
  const p = buildPlan([{ name: 'x.pdf', pages: [] }], { mode: 'merge' });
  assert.equal(p.jobs.length, 0);
  assert.ok(p.error);
});

/* ---------------- 辅助函数 ---------------- */

test('stem 去扩展名并清掉非法字符', () => {
  assert.equal(stem('报告.PDF'), '报告');
  assert.equal(stem('a/b:c?.pdf'), 'a_b_c_');
  assert.equal(stem(''), 'PDF');
});

test('chunk 按 N 切分，N 非法时退化为 1', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([1, 2], 0), [[1], [2]]);
});

test('pagesLabel 连续区间与离散页', () => {
  assert.equal(pagesLabel([2, 3, 4]), '第 2-4 页');
  assert.equal(pagesLabel([5]), '第 5 页');
  assert.equal(pagesLabel([5, 2]), '第 2, 5 页');
  assert.equal(pagesLabel([]), '无');
});
