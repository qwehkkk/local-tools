#!/usr/bin/env node
/**
 * 换域名 —— 把所有页面的 canonical、sitemap.xml、robots.txt 一次性指向新站点。
 *
 *   node tools/set-domain.mjs https://local-tools.app.workbuddy.host
 *   node tools/set-domain.mjs https://toolona.com/tools   （带子路径也行）
 *
 * 页面本身只用相对路径互相引用，所以只有 canonical 需要改。
 * 改完记得跑 npm run verify:all —— 验证脚本不看 canonical，但顺带能确认页面没被改坏。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, listPages, routeOf, priorityOf } from './pages.mjs';

const arg = process.argv[2];

function usage(msg) {
  if (msg) console.error('错误：' + msg);
  console.error('用法：node tools/set-domain.mjs https://example.com[/base]');
  process.exit(1);
}

if (!arg) usage('缺少站点地址');
let base;
try {
  base = new URL(arg);
} catch {
  usage('不是合法的 URL：' + arg);
}
if (base.protocol !== 'https:' && base.protocol !== 'http:') usage('只支持 http/https');
const basePath = base.pathname.replace(/\/+$/, ''); // 去掉尾斜杠，空串表示根
const origin = base.origin + basePath;

/* ---------- 页面 ---------- */

const pages = listPages();

for (const rel of pages) {
  const file = join(root, rel);
  // listPages() 只返回真实存在的文件，这里再判一次存在性没有意义，
  // 而且 exists() 内部会再 join 一次 root —— 传绝对路径进去永远判 false，
  // 于是所有页面都被"跳过"，脚本却照常 exit 0。别再这么写。
  const html = readFileSync(file, 'utf8');
  // 页面路径 → 站点路径：index.html 结尾的去掉文件名，保持目录形式
  const url = origin + routeOf(rel);
  // 除了 canonical，og:url / og:image 也是绝对地址 —— 换域名时一起改，
  // 否则分享出去的卡片图会指向旧域名，而这件事在浏览器里看不出来。
  const ogImage = origin + '/assets/og.png';
  const next = html
    .replace(/(<link rel="canonical" href=")[^"]*(")/, `$1${url}$2`)
    .replace(/(<meta property="og:url" content=")[^"]*(")/, `$1${url}$2`)
    .replace(/(<meta property="og:image" content=")[^"]*(")/, `$1${ogImage}$2`)
    .replace(/(<meta name="twitter:image" content=")[^"]*(")/, `$1${ogImage}$2`);
  if (next === html && !html.includes(url)) {
    console.error(`⚠ ${rel} 没找到 canonical，未改动`);
    continue;
  }
  writeFileSync(file, next);
  console.log(`✓ ${rel} → ${url}`);
}

/* ---------- sitemap ---------- */

const today = new Date().toISOString().slice(0, 10);
const urls = pages.map((p) => {
  const route = routeOf(p);
  return `  <url>\n    <loc>${origin}${route}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>${priorityOf(p)}</priority>\n  </url>`;
});

writeFileSync(
  join(root, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`
);
console.log(`✓ sitemap.xml（${urls.length} 条）`);

/* ---------- robots.txt ---------- */

// 开发文件会上传（静态托管没有排除机制），别让爬虫把它们当页面收录。
writeFileSync(
  join(root, 'robots.txt'),
  [
    'User-agent: *',
    'Allow: /',
    '',
    '# 开发文件，不是页面',
    'Disallow: /tests/',
    'Disallow: /tools/verify',
    'Disallow: /tools/push-via-api',
    'Disallow: /tools/set-domain',
    'Disallow: /tools/pages.mjs',
    'Disallow: /tools/serve.mjs',
    'Disallow: /tools/shot.mjs',
    'Disallow: /tools/diag.mjs',
    'Disallow: /tools/make-',
    'Disallow: /README.md',
    'Disallow: /package.json',
    '',
    `Sitemap: ${origin}/sitemap.xml`,
    '',
  ].join('\n')
);
console.log('✓ robots.txt');

console.log(`\n站点根：${origin}`);
