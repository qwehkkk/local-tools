#!/usr/bin/env node
/**
 * 全站静态一致性检查 —— 发布前跑一遍，确认没有死链、canonical 没写错、sitemap 没漏页。
 *
 *   node tools/verify-site.mjs
 *
 * 只读文件系统，不起浏览器。刻意不依赖任何包。
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
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

/* ---------- 收集页面 ---------- */

const pages = [];
// 目录结构是固定的三层，直接枚举比递归省事，也避免把 tests/ 里的东西算进来
for (const rel of ['index.html', 'tools/pii-mask/index.html', 'tools/image-shrink/index.html', 'tools/pdf-toolkit/index.html']) {
  pages.push(rel);
}

// pages 里是 POSIX 风格路径，路由要以 / 切分（Windows 的 sep 是 \，不能直接用）
const routeOf = (rel) => '/' + rel.replace(/(^|\/)index\.html$/, '$1');

/* ---------- 1. 页面存在 ---------- */

console.log('\n=== 页面存在 ===');
for (const rel of pages) {
  ok(existsSync(join(root, rel)), `${rel} 存在`);
}

/* ---------- 2. 相对链接都能解析到文件 ---------- */

console.log('\n=== 相对链接 ===');
const linkRe = /(?:href|src)="([^"]+)"/g;
let deadLinks = 0;
let linkCount = 0;

for (const rel of pages) {
  const file = join(root, rel);
  if (!existsSync(file)) continue;
  const html = readFileSync(file, 'utf8');
  const baseDir = dirname(file);

  for (const m of html.matchAll(linkRe)) {
    const url = m[1];
    if (/^(https?:|mailto:|#|data:|javascript:)/.test(url)) continue;
    linkCount++;
    // 去掉 query / hash
    const clean = url.split('#')[0].split('?')[0];
    if (!clean) continue;
    let target = resolve(baseDir, clean);
    // 目录链接（以 / 结尾或解析到目录）→ 找 index.html
    if (clean.endsWith('/') || (existsSync(target) && statSync(target).isDirectory())) {
      target = join(target, 'index.html');
    }
    if (!existsSync(target)) {
      deadLinks++;
      console.log(`  ✗ ${rel} → ${url}（解析为 ${relative(root, target)}，不存在）`);
    }
  }
}
ok(deadLinks === 0, `全部 ${linkCount} 个相对链接都可解析`);

/* ---------- 3. 工具页必须有回列表的入口 ---------- */

console.log('\n=== 返回入口 ===');
for (const rel of pages) {
  if (rel === 'index.html') continue;
  const html = readFileSync(join(root, rel), 'utf8');
  ok(/class="backlink"[^>]*href="\.\.\/\.\.\/"/.test(html), `${rel} 有返回列表的链接`);
}

/* ---------- 4. canonical 自指且带尾斜杠 ---------- */

console.log('\n=== canonical ===');
let canonHost = null;
for (const rel of pages) {
  const html = readFileSync(join(root, rel), 'utf8');
  const m = html.match(/<link rel="canonical" href="([^"]+)"/);
  if (!m) {
    ok(false, `${rel} 没有 canonical`);
    continue;
  }
  const url = m[1];
  const parsed = new URL(url);
  canonHost ??= parsed.origin;
  const route = routeOf(rel);
  ok(parsed.origin === canonHost, `${rel} 的 canonical 与其他页同域（${parsed.origin}）`);
  ok(parsed.pathname === route, `${rel} 的 canonical 路径自指（${parsed.pathname} = ${route}）`);
  ok(parsed.pathname.endsWith('/'), `${rel} 的 canonical 以斜杠结尾`);
}

/* ---------- 5. sitemap 覆盖全部页面 ---------- */

console.log('\n=== sitemap ===');
const smPath = join(root, 'sitemap.xml');
if (!existsSync(smPath)) {
  ok(false, 'sitemap.xml 存在');
} else {
  const sm = readFileSync(smPath, 'utf8');
  const locs = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  ok(locs.length === pages.length, `sitemap 条目数等于页面数（${locs.length} = ${pages.length}）`);
  for (const rel of pages) {
    const route = routeOf(rel);
    ok(locs.some((l) => new URL(l).pathname === route), `sitemap 含 ${route}`);
  }
  ok(locs.every((l) => new URL(l).origin === canonHost), 'sitemap 与 canonical 同域');
}

/* ---------- 6. robots.txt ---------- */

console.log('\n=== robots.txt ===');
const rbPath = join(root, 'robots.txt');
if (!existsSync(rbPath)) {
  ok(false, 'robots.txt 存在');
} else {
  const rb = readFileSync(rbPath, 'utf8');
  ok(/Sitemap:\s*https?:\/\/\S+\/sitemap\.xml/.test(rb), 'robots.txt 声明了 sitemap');
  ok(rb.includes('Disallow: /tests/'), 'robots.txt 屏蔽了测试目录');
}

/* ---------- 7. 页面不引用任何外部资源 ---------- */

console.log('\n=== 零外部依赖 ===');
for (const rel of pages) {
  const html = readFileSync(join(root, rel), 'utf8');
  const external = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)]
    .map((m) => m[1])
    .filter((u) => !u.startsWith(canonHost));
  ok(external.length === 0, `${rel} 没有外域资源引用${external.length ? '：' + external.join(', ') : ''}`);
}

/* ---------- 汇总 ---------- */

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
