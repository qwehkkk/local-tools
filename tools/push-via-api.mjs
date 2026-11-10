#!/usr/bin/env node
/**
 * 用 GitHub Git Data API 推送，绕开 `git push`。
 *
 *   npm run push            # 把当前 HEAD 的内容推到 origin 的对应分支
 *   npm run push -- --dry   # 只打印将要上传什么
 *
 * 为什么需要它：本机出网代理只放行 api.github.com，`git push` 连 github.com:443
 * 会报 `CONNECT tunnel failed, response 502`。API 走的是另一个域名，所以能用。
 *
 * 它做的事和 git push 等价：读索引里的每个 blob → 建 tree → 建 commit（parent 是
 * 远程当前 HEAD 的根提交）→ 强制更新 ref。远程历史因此只有「初始化 + 一次正式提交」，
 * 不会累积一串中间版本。
 *
 * 代价：远程 commit 的 SHA 与本地不同（本地对象库里没有那个 commit）。
 * 换到能直连 github.com 的机器上首次 push 前，先 `git fetch && git reset --hard origin/main`。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const DRY = process.argv.includes('--dry');

/* ---------- 定位仓库 ---------- */

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

const remoteUrl = git('remote', 'get-url', 'origin');
const m = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
if (!m) throw new Error(`无法从 origin 解析 owner/repo：${remoteUrl}`);
const [, OWNER, REPO] = m;

const BRANCH = git('rev-parse', '--abbrev-ref', 'HEAD');
const MESSAGE = git('log', '-1', '--format=%B');
const AUTHOR_NAME = git('config', 'user.name') || OWNER;
const AUTHOR_EMAIL = git('config', 'user.email');
if (!AUTHOR_EMAIL) throw new Error('没有配置 git user.email');

/* ---------- 取凭据（不打印） ---------- */

function getToken() {
  const out = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    encoding: 'utf8',
  });
  const t = out.match(/^password=(.+)$/m);
  if (!t) throw new Error('git 凭据里没有 password，先在能联网的机器上 push 一次或重新授权');
  return t[1].replace(/\s/g, '');
}
const TOKEN = getToken();

async function api(path, init = {}) {
  const res = await fetch('https://api.github.com' + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'local-tools-push',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 300) };
  }
  if (!res.ok) {
    throw new Error(`${init.method || 'GET'} ${path} → HTTP ${res.status}：${body.message || JSON.stringify(body).slice(0, 200)}`);
  }
  return body;
}

/* ---------- 读索引（不是工作区，行尾已按 .gitattributes 规范化） ---------- */

const entries = git('ls-files', '-s')
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const [meta, path] = line.split('\t');
    const [, mode, sha] = meta.split(' ');
    return { mode, sha, path };
  });

console.log(`→ ${OWNER}/${REPO} · 分支 ${BRANCH} · ${entries.length} 个文件`);

if (DRY) {
  entries.forEach((e) => console.log(`  ${e.sha.slice(0, 7)}  ${e.path}`));
  console.log('（--dry，未上传）');
  process.exit(0);
}

/* ---------- 远程基线：空仓库要先建分支 ---------- */

async function ensureBase() {
  try {
    const ref = await api(`/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
    return ref.object.sha;
  } catch {
    // 空仓库读 ref 返回 409
    const init = await api(`/repos/${OWNER}/${REPO}/contents/.gitattributes`, {
      method: 'PUT',
      body: JSON.stringify({
        message: 'chore: 初始化仓库',
        content: Buffer.from('# placeholder\n').toString('base64'),
        branch: BRANCH,
      }),
    });
    console.log(`✓ 初始化分支（${init.commit.sha.slice(0, 7)}）`);
    return init.commit.sha;
  }
}

/** 回溯到根 commit：避免把一串中间版本留在远程历史上。 */
async function rootOf(sha) {
  let cur = sha;
  for (let i = 0; i < 30; i++) {
    const c = await api(`/repos/${OWNER}/${REPO}/git/commits/${cur}`);
    if (!c.parents?.length) return cur;
    cur = c.parents[0].sha;
  }
  return cur;
}

const parent = await rootOf(await ensureBase());

/* ---------- blob ---------- */

const blobs = [];
const queue = [...entries];
const CONCURRENCY = 6;
let done = 0;

async function worker() {
  while (queue.length) {
    const e = queue.shift();
    // 用索引里的内容（git cat-file），保证上传的就是将来 clone 下来会得到的那份字节
    const content = execFileSync('git', ['cat-file', 'blob', e.sha]);
    const body = await api(`/repos/${OWNER}/${REPO}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({ content: content.toString('base64'), encoding: 'base64' }),
    });
    blobs.push({ path: e.path, mode: e.mode, type: 'blob', sha: body.sha });
    done++;
    if (done % 10 === 0 || done === entries.length) process.stdout.write(`  blob ${done}/${entries.length}\r`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
console.log(`✓ blob ${blobs.length} 个`);

/* ---------- tree + commit + ref ---------- */

const tree = await api(`/repos/${OWNER}/${REPO}/git/trees`, {
  method: 'POST',
  body: JSON.stringify({ tree: blobs }),
});

const now = new Date().toISOString();
const commit = await api(`/repos/${OWNER}/${REPO}/git/commits`, {
  method: 'POST',
  body: JSON.stringify({
    message: MESSAGE,
    tree: tree.sha,
    parents: [parent],
    author: { name: AUTHOR_NAME, email: AUTHOR_EMAIL, date: now },
    committer: { name: AUTHOR_NAME, email: AUTHOR_EMAIL, date: now },
  }),
});

try {
  await api(`/repos/${OWNER}/${REPO}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha: commit.sha }),
  });
} catch (e) {
  if (!String(e.message).includes('42')) throw e; // 422/409：分支已存在
  await api(`/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha, force: true }),
  });
}

console.log(`✓ commit ${commit.sha.slice(0, 7)}`);
console.log(`  https://github.com/${OWNER}/${REPO}/commit/${commit.sha}`);
