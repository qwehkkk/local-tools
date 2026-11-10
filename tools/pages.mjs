/**
 * 页面清单 —— 唯一的真源。
 *
 * set-domain.mjs（改 canonical / sitemap）和 verify-site.mjs（检查死链、canonical、sitemap 覆盖率）
 * 都从这里取清单。以前两个脚本各自硬编码了 4 个页面，加一个页面就会漏改其中一处，
 * 而漏改 sitemap 不会有任何报错 —— 只是新页面永远不会被发现。
 *
 * 规则：扫到第二层目录里的 index.html。`tests/`、`assets/` 里的东西不是页面。
 * 每个页面必须放在自己的目录下（privacy/index.html 而不是 privacy.html），
 * 这样路由统一以斜杠结尾，canonical 不用分两种写法。
 */
import { readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 不是页面的目录 */
const SKIP = new Set(['tests', 'assets', 'node_modules', '.git', '.dev']);

/**
 * @returns {string[]} POSIX 风格的相对路径，例如 'index.html'、'tools/pii-mask/index.html'
 */
export function listPages() {
  const out = [];

  function walk(relDir, depth) {
    const dir = relDir ? join(root, relDir) : root;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (depth >= 2 || SKIP.has(e.name)) continue;
        walk(relDir ? `${relDir}/${e.name}` : e.name, depth + 1);
      } else if (e.name === 'index.html') {
        out.push(relDir ? `${relDir}/index.html` : 'index.html');
      }
    }
  }

  walk('', 0);
  // 顺序稳定：首页在前，其余按字母。
  return out.sort((a, b) => (a === 'index.html' ? -1 : b === 'index.html' ? 1 : a.localeCompare(b)));
}

/** 文件路径 → 站点路由，例如 'tools/pii-mask/index.html' → '/tools/pii-mask/' */
export function routeOf(rel) {
  return '/' + rel.replace(/(^|\/)index\.html$/, '$1');
}

/** sitemap 里的优先级：首页最高，工具页次之，说明类页面最低 */
export function priorityOf(rel) {
  const route = routeOf(rel);
  if (route === '/') return '1.0';
  if (route.startsWith('/tools/')) return '0.8';
  return '0.4';
}

export function exists(rel) {
  return existsSync(join(root, rel));
}
