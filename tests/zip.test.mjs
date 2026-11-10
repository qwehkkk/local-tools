import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { crc32, makeZip, uniqueName } from '../assets/zip.js';

/* ---------------- CRC32 ---------------- */

test('crc32 与标准测试向量一致', () => {
  // 业界通用校验向量：CRC-32("123456789") = 0xCBF43926
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
  assert.equal(crc32(new TextEncoder().encode('a')), 0xe8b7be43);
});

/* ---------------- 结构 ---------------- */

const enc = (s) => new TextEncoder().encode(s);

test('生成 ZIP 的三个关键签名都在正确位置', () => {
  const zip = makeZip([{ name: 'a.txt', data: enc('hello') }]);

  const u32 = (off) => new Uint8Array(zip.buffer, off, 4);
  // 本地文件头
  assert.deepEqual([...u32(0)], [0x50, 0x4b, 0x03, 0x04]);
  // 中央目录结束记录在最后 22 字节的首部
  assert.deepEqual([...u32(zip.length - 22)], [0x50, 0x4b, 0x05, 0x06]);
  // 中央目录项：本地头(30) + 文件名(5) + 数据(5)
  assert.deepEqual([...u32(40)], [0x50, 0x4b, 0x01, 0x02]);
});

test('条目数与中央目录偏移量自洽', () => {
  const entries = [
    { name: 'one.txt', data: enc('111') },
    { name: 'two.txt', data: enc('2222') },
    { name: 'three.txt', data: enc('') },
  ];
  const zip = makeZip(entries);
  const dv = new DataView(zip.buffer);
  const eocd = zip.length - 22;

  assert.equal(dv.getUint16(eocd + 8, true), 3, '本磁盘条目数');
  assert.equal(dv.getUint16(eocd + 10, true), 3, '总条目数');

  const cdOffset = dv.getUint32(eocd + 16, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  assert.equal(cdOffset + cdSize, eocd, '中央目录应紧接在结束记录之前');
});

test('UTF-8 标志位已置位（中文文件名不乱码）', () => {
  const zip = makeZip([{ name: '图片-压缩.webp', data: enc('x') }]);
  const dv = new DataView(zip.buffer);
  assert.equal(dv.getUint16(6, true) & 0x0800, 0x0800, '本地头 UTF-8 位');
});

/* ---------------- 交叉校验：交给 Python zipfile 解 ---------------- */

test('Python zipfile 能正确解出全部内容与 CRC（最硬的一条）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zipchk-'));
  const zipPath = join(dir, 'out.zip');

  const cases = [
    { name: 'plain.txt', data: enc('hello world') },
    { name: '中文 文件名.txt', data: enc('中文内容测试') },
    { name: 'empty.bin', data: new Uint8Array(0) },
    { name: 'sub/nested.dat', data: new Uint8Array([0, 1, 2, 255, 254, 128]) },
  ];
  writeFileSync(zipPath, makeZip(cases, new Date(2026, 10, 8, 18, 30, 0)));

  assert.ok(existsSync(zipPath));

  // 让 Python 真正解压并回读：既验证结构合法，也验证 CRC 正确
  const py = `
import zipfile, json, sys
z = zipfile.ZipFile(sys.argv[1])
bad = z.testzip()
names = z.namelist()
out = {n: list(z.read(n)) for n in names}
print(json.dumps({"bad": bad, "names": names, "data": out}, ensure_ascii=False))
`;
  let raw;
  try {
    raw = execFileSync('python', ['-c', py, zipPath], { encoding: 'utf8' });
  } catch (e) {
    // 没装 Python 就跳过这一条，不假装通过
    if (e.code === 'ENOENT') {
      console.log('（跳过：本机无 python，无法交叉校验）');
      return;
    }
    throw e;
  }

  const res = JSON.parse(raw);
  assert.equal(res.bad, null, 'zipfile.testzip() 应无损坏条目');
  assert.deepEqual(res.names, cases.map((c) => c.name));
  for (const c of cases) {
    assert.deepEqual(res.data[c.name], [...c.data], `内容不一致：${c.name}`);
  }
});

test('空条目列表也能生成合法的空 ZIP', () => {
  const zip = makeZip([]);
  assert.equal(zip.length, 22);
  const dv = new DataView(zip.buffer);
  assert.equal(dv.getUint32(0, true), 0x06054b50);
  assert.equal(dv.getUint16(10, true), 0, '总条目数为 0');
});

/* ---------------- 重名处理 ---------------- */

test('重名自动加序号，扩展名保留在最后', () => {
  const used = new Set();
  assert.equal(uniqueName('a.webp', used), 'a.webp');
  assert.equal(uniqueName('a.webp', used), 'a-2.webp');
  assert.equal(uniqueName('a.webp', used), 'a-3.webp');
  assert.equal(uniqueName('noext', used), 'noext');
  assert.equal(uniqueName('noext', used), 'noext-2');
});
