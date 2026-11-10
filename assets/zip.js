/**
 * 最小 ZIP 写入器（仅 store 模式，不做压缩）
 *
 * 为什么不用 JSZip：图片本身已是压缩格式，再 deflate 一遍收益接近 0，
 * 却要多背 100KB 依赖。这里只拼 ZIP 的容器结构，约 100 行，够用且可测。
 *
 * 支持：UTF-8 文件名（中文名不会乱码，靠通用标志位 bit 11）、多文件、空文件。
 * 不支持：单文件 > 4GB（需要 ZIP64）、目录项、压缩。
 */

/* ---------------- CRC32 ---------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/** 标准 CRC-32（IEEE 802.3），ZIP 各段的校验值都用它 */
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/* ---------------- DOS 时间 ---------------- */

// ZIP 沿用 MS-DOS 的时间格式：秒只有 2 秒精度，年份从 1980 起算。
function dosDateTime(d) {
  const year = Math.max(1980, d.getFullYear());
  const time =
    ((d.getHours() & 0x1f) << 11) |
    ((d.getMinutes() & 0x3f) << 5) |
    ((d.getSeconds() >> 1) & 0x1f);
  const date =
    (((year - 1980) & 0x7f) << 9) |
    (((d.getMonth() + 1) & 0x0f) << 5) |
    (d.getDate() & 0x1f);
  return { time: time & 0xffff, date: date & 0xffff };
}

/* ---------------- 主体 ---------------- */

/**
 * @param {Array<{name: string, data: Uint8Array}>} entries
 * @returns {Uint8Array} 完整 ZIP 字节
 */
export function makeZip(entries, now = new Date()) {
  const enc = new TextEncoder();
  const { time, date } = dosDateTime(now);
  const parts = [];   // 按顺序累积：本地头 + 数据
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const data = e.data;
    const size = data.length;
    const crc = crc32(data);

    /* --- 本地文件头 30 字节 --- */
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);   // PK\x03\x04
    lv.setUint16(4, 20, true);           // 解压所需版本 2.0
    lv.setUint16(6, 0x0800, true);       // 标志位：文件名 UTF-8
    lv.setUint16(8, 0, true);            // 压缩方法 0 = store
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);        // 压缩后大小
    lv.setUint32(22, size, true);        // 原始大小
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);           // 扩展字段长度
    local.set(nameBytes, 30);

    parts.push(local, data);

    /* --- 中央目录项 46 字节 --- */
    const cen = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);   // PK\x01\x02
    cv.setUint16(4, 20, true);           // 创建版本
    cv.setUint16(6, 20, true);           // 解压所需版本
    cv.setUint16(8, 0x0800, true);       // 标志位：文件名 UTF-8
    cv.setUint16(10, 0, true);           // store
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);           // 扩展字段
    cv.setUint16(32, 0, true);           // 注释
    cv.setUint16(34, 0, true);           // 起始磁盘号
    cv.setUint16(36, 0, true);           // 内部属性
    cv.setUint32(38, 0, true);           // 外部属性
    cv.setUint32(42, offset, true);      // 本地头偏移
    cen.set(nameBytes, 46);
    central.push(cen);

    offset += local.length + size;
  }

  /* --- 中央目录结束记录 22 字节 --- */
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);     // PK\x05\x06
  ev.setUint16(4, 0, true);              // 当前磁盘号
  ev.setUint16(6, 0, true);              // 中央目录起始磁盘号
  ev.setUint16(8, entries.length, true); // 本磁盘条目数
  ev.setUint16(10, entries.length, true);// 总条目数
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);        // 中央目录偏移
  ev.setUint16(20, 0, true);             // 注释长度

  const total = offset + cdSize + eocd.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of parts) { out.set(c, p); p += c.length; }
  for (const c of central) { out.set(c, p); p += c.length; }
  out.set(eocd, p);
  return out;
}

/** 重名时自动加序号，避免解压后互相覆盖 */
export function uniqueName(name, used) {
  if (!used.has(name)) { used.add(name); return name; }
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let i = 2;
  let candidate;
  do {
    candidate = `${base}-${i}${ext}`;
    i++;
  } while (used.has(candidate));
  used.add(candidate);
  return candidate;
}
