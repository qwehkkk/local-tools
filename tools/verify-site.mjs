#!/usr/bin/env node
/**
 * 全站静态一致性检查 —— 发布前跑一遍，确认没有死链、canonical 没写错、sitemap 没漏页。
 *
 *   node tools/verify-site.mjs
 *
 * 只读文件系统，不起浏览器。刻意不依赖任何包。
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { root, listPages, routeOf } from './pages.mjs';
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

// 清单来自 tools/pages.mjs（与 set-domain.mjs 共用），加页面不用改这里
const pages = listPages();

/** 页面内指向站点根的相对前缀：'index.html' → './'，'tools/x/index.html' → '../../' */
const prefixOf = (rel) => {
  const depth = rel.split('/').length - 1;
  return depth === 0 ? './' : '../'.repeat(depth);
};

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
  const m = html.match(/class="backlink"[^>]*href="([^"]+)"/);
  // 不同层级的页面，回根目录的相对路径不一样（../ 或 ../../）。
  // 以前这里硬编码成 ../../，加一级页面就会误报。
  ok(!!m && m[1] === prefixOf(rel), `${rel} 有返回列表的链接（${prefixOf(rel)}）`);
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

// 「零外部请求」是这个站唯一的核心卖点，必须当断言守。
// 注意只算标签上的 src/href（<link>、<script>、<img>），<a> 是用户点了才跳转的锚点，
// 不会产生任何自动请求 —— 页脚链到 GitHub 源码不能因此判失败。
console.log('\n=== 零外部依赖 ===');
for (const rel of pages) {
  const html = readFileSync(join(root, rel), 'utf8');
  const external = [...html.matchAll(/<([a-zA-Z][\w-]*)\b[^>]*?\s(?:src|href)="(https?:\/\/[^"]+)"/g)]
    .filter((m) => m[1].toLowerCase() !== 'a')
    .map((m) => m[2])
    .filter((u) => !u.startsWith(canonHost));
  ok(external.length === 0, `${rel} 没有外域资源引用${external.length ? '：' + external.join(', ') : ''}`);
}

/* ---------- 8. 页面骨架 ---------- */

console.log('\n=== 页面骨架 ===');
for (const rel of pages) {
  const html = readFileSync(join(root, rel), 'utf8');
  const p = prefixOf(rel);

  ok([...html.matchAll(/<h1\b/g)].length === 1, `${rel} 有且只有一个 h1`);
  ok([...html.matchAll(/<h2\b/g)].length > 0, `${rel} 用了 h2 分节`);

  const desc = (html.match(/<meta name="description" content="([^"]*)"/) ?? [])[1];
  ok(!!desc && desc.length >= 40 && desc.length <= 160, `${rel} 有 meta description 且长度 ${desc ? desc.length : 0} 字（40–160）`);

  // 分享出去要有图、要指对地址，否则微信/推特/群里都是一片空白
  ok(html.includes(`<link rel="icon" href="${p}assets/favicon.svg"`), `${rel} 声明了 favicon`);
  ok(/property="og:image" content="https?:\/\/[^"]+"/.test(html), `${rel} 声明了 og:image（绝对地址）`);
  ok(/property="og:url" content="https?:\/\/[^"]+"/.test(html), `${rel} 声明了 og:url`);

  // og:url 必须与 canonical 完全一致，否则分享卡片指向的地址和搜索引擎认的不是同一个
  const ogUrl = (html.match(/<meta property="og:url" content="([^"]*)"/) ?? [])[1];
  const canon = (html.match(/<link rel="canonical" href="([^"]*)"/) ?? [])[1];
  ok(ogUrl === canon, `${rel} 的 og:url 与 canonical 一致`);

  // 卡片图必须真的存在，否则分享出去是空白 —— 这种错在本地看不出来
  const ogImg = (html.match(/<meta property="og:image" content="([^"]*)"/) ?? [])[1];
  if (ogImg) {
    const p2 = new URL(ogImg).pathname.replace(/^\//, '');
    ok(existsSync(join(root, p2)), `${rel} 的 og:image 文件存在（${p2}）`);
  }

  // 页脚导航：所有页面都要能横向走到隐私说明和关于，
  // 否则这两个页面只能靠 sitemap 被看到，内部一条链接都没有。
  // 页面自己那一项不用自指，跳过。
  ok(rel.startsWith('privacy/') || html.includes(`href="${p}privacy/"`), `${rel} 页脚链到隐私说明`);
  ok(rel.startsWith('about/') || html.includes(`href="${p}about/"`), `${rel} 页脚链到关于`);
}

/* ---------- 9. 结构化数据可解析 ---------- */

console.log('\n=== 结构化数据 ===');
for (const rel of pages) {
  const html = readFileSync(join(root, rel), 'utf8');
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  ok(blocks.length > 0, `${rel} 有 JSON-LD${blocks.length ? `（${blocks.length} 块）` : ''}`);
  let parsed = 0;
  for (const b of blocks) {
    try {
      const j = JSON.parse(b);
      if (j['@context'] && j['@type']) parsed++;
    } catch {
      /* 下面统一判 */
    }
  }
  ok(parsed === blocks.length, `${rel} 的 JSON-LD 全部能 JSON.parse 且有 @context/@type`);
}

/* ---------- 汇总 ---------- */

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
