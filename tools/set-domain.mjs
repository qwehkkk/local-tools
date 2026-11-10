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
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
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

const pages = ['index.html', 'tools/pii-mask/index.html', 'tools/image-shrink/index.html', 'tools/pdf-toolkit/index.html'];

for (const rel of pages) {
  const file = join(root, rel);
  if (!existsSync(file)) {
    console.error(`跳过（不存在）：${rel}`);
    continue;
  }
  const html = readFileSync(file, 'utf8');
  // 页面路径 → 站点路径：index.html 结尾的去掉文件名，保持目录形式
  const route = '/' + relative(root, file).split(sep).join('/').replace(/(^|\/)index\.html$/, '$1');
  const url = origin + route;
  const next = html.replace(/(<link rel="canonical" href=")[^"]*(")/, `$1${url}$2`);
  if (next === html && !html.includes(url)) {
    console.error(`⚠ ${rel} 没找到 canonical，未改动`);
    continue;
  }
  writeFileSync(file, next);
  console.log(`✓ ${rel} → ${url}`);
}

/* ---------- sitemap ---------- */

const today = new Date().toISOString().slice(0, 10);
const urls = pages
  .filter((p) => existsSync(join(root, p)))
  .map((p) => {
    const route = '/' + relative(root, join(root, p)).split(sep).join('/').replace(/(^|\/)index\.html$/, '$1');
    const priority = route === '/' ? '1.0' : '0.8';
    return `  <url>\n    <loc>${origin}${route}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>${priority}</priority>\n  </url>`;
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
