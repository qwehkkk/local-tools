/**
 * PII 识别与脱敏规则引擎
 * ------------------------------------------------------------
 * 设计原则：
 * 1. 零依赖、零网络、纯函数 —— 可直接在浏览器与 Node 中运行
 * 2. 宁可少报也不误报：所有「弱特征」规则必须带校验位或上下文关键词
 * 3. 冲突消解 = 校验通过优先 > 规则优先级高优先 > 匹配更长优先
 *
 * 边界判断不用 lookbehind（Safari 16.4 以下不支持），改为匹配后手工检查，
 * 这样正则本身保持简单，也便于逐条测试。
 */

/* ------------------------------------------------------------------ *
 * 校验算法
 * ------------------------------------------------------------------ */

/** 身份证 18 位校验位（GB 11643-1999） */
export function checkChineseId(id) {
  if (!/^\d{17}[\dXx]$/.test(id)) return false;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const codes = '10X98765432';
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += Number(id[i]) * weights[i];
  return codes[sum % 11] === id[17].toUpperCase();
}

/** 银行卡 Luhn 校验 */
export function luhn(digits) {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** 统一社会信用代码校验（GB 32100-2015） */
export function checkCreditCode(code) {
  const CHARS = '0123456789ABCDEFGHJKLMNPQRTUWXY';
  if (!/^[0-9A-HJ-NPQRTUWXY]{18}$/.test(code)) return false;
  const weights = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const idx = CHARS.indexOf(code[i]);
    if (idx < 0) return false;
    sum += idx * weights[i];
  }
  const check = (31 - (sum % 31)) % 31;
  return CHARS[check] === code[17];
}

/** IPv4 合法性 */
function validIPv4(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    if (p.length > 1 && p[0] === '0') return false;
    const n = Number(p);
    return n >= 0 && n <= 255;
  });
}

/* ------------------------------------------------------------------ *
 * 边界判断
 * ------------------------------------------------------------------ */

const RE_DIGIT = /[0-9]/;
const RE_ALNUM = /[0-9A-Za-z_]/;

function boundaryOk(text, start, end, mode) {
  if (!mode || mode === 'none') return true;
  const test = mode === 'digit' ? RE_DIGIT : RE_ALNUM;
  const before = start > 0 ? text[start - 1] : '';
  const after = end < text.length ? text[end] : '';
  if (before && test.test(before)) return false;
  if (after && test.test(after)) return false;
  return true;
}

/* ------------------------------------------------------------------ *
 * 人名识别用的词表
 * ------------------------------------------------------------------ */

// 能引出人名的字段名
const NAME_KEYWORDS = [
  '姓名', '联系人', '收件人', '寄件人', '签收人', '法定代表人', '法人代表',
  '负责人', '经办人', '审核人', '批准人', '申请人', '委托人', '代理人',
  '担保人', '见证人', '投保人', '被保险人', '受益人', '开户人', '持卡人',
  '借款人', '贷款人', '患者', '学生姓名', '家长', '配偶',
  '甲方', '乙方', '丙方', '丁方', '买方', '卖方', '供方', '需方',
  '承租方', '出租方', '承租人', '出租人',
].join('|');

// 字段名后面如果紧跟这些词，说明这一句不是在给出「值」，而是在描述动作。
// 例：「甲方指定联系人张伟」——甲方后面是动词，真正的字段名是「联系人」。
// 注意：「为 / 是 / 系」不在此列，它们后面跟的正是值（「联系人为王芳」）。
const NAME_STOP_PREFIX =
  '指定|委托|委派|聘请|授权|要求|同意|确认|签署|负责|联系|派|由|将|已|应|须|需|可|不|未|了';

/* ------------------------------------------------------------------ *
 * 人名尾巴清理
 * 中文人名没有形态特征，只能贪心取 2–4 字，于是「联系人张伟负责后续」会被读成
 * 「张伟负责」。这里把尾巴上的动词/称谓剥掉，保证同一个「张伟」始终是同一个占位符。
 * 宁可少剥：剥错会漏遮真名，剥少只是多遮一个动词。
 * ------------------------------------------------------------------ */

const NAME_TAIL_WORDS = [
  '负责', '联系', '签字', '确认', '先生', '女士', '小姐', '经理', '主任', '科长',
  '处长', '总监', '电话', '手机', '地址', '邮箱', '身份', '账号', '工号', '本人',
  '所在', '任职', '同事', '同学', '家属', '委托', '授权', '公司', '单位',
];

// 单字只在 3 字以上时剥，避免把「张伟」削成「张」
const NAME_TAIL_CHARS = '先女男经主处科总电手地邮身账工本所同负联签确的在将已为是与和及或等责理任长员';

// 人名后面常跟这些虚词，遇到就是名字的边界（「王芳的助理」→ 王芳）
const NAME_BOUNDARY = /[的在了将已为是与和及或等把被从对向，。、；：！？\s（）()《》\-—…·]/;

function trimName(raw) {
  // 1. 先按分界符截断
  for (let i = 1; i < raw.length; i++) {
    if (NAME_BOUNDARY.test(raw[i])) return raw.slice(0, i);
  }
  // 2. 再按多字停止词剥尾
  for (const w of NAME_TAIL_WORDS) {
    if (raw.length > w.length + 1 && raw.endsWith(w)) return raw.slice(0, -w.length);
  }
  // 3. 最后按单字剥（只在 3 字以上，避免把「张伟」削成「张」）
  if (raw.length >= 3 && NAME_TAIL_CHARS.includes(raw[raw.length - 1])) {
    return raw.slice(0, -1);
  }
  return raw;
}

/* ------------------------------------------------------------------ *
 * 规则表
 * priority 越大越优先；只有校验通过的候选才能拿到高优先级。
 * ------------------------------------------------------------------ */

export const RULES = [
  {
    id: 'cn_id',
    label: '身份证号',
    severity: 'high',
    regex: /[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]/g,
    boundary: 'alnum',
    priority: 100,
    validate: (m) => checkChineseId(m),
    validOnly: false,
  },
  {
    id: 'cn_credit_code',
    label: '统一社会信用代码',
    severity: 'high',
    regex: /[0-9A-HJ-NPQRTUWXY]{2}\d{6}[0-9A-HJ-NPQRTUWXY]{10}/g,
    boundary: 'alnum',
    priority: 95,
    validate: (m) => checkCreditCode(m),
    validOnly: false,
  },
  {
    id: 'bank_card',
    label: '银行卡号',
    severity: 'high',
    regex: /\d{16,19}/g,
    boundary: 'digit',
    priority: 90,
    validate: (m) => luhn(m),
    validOnly: false,
  },
  {
    id: 'cn_mobile',
    label: '手机号',
    severity: 'high',
    regex: /1[3-9]\d{9}/g,
    boundary: 'digit',
    priority: 85,
    validate: () => true,
    validOnly: true,
  },
  {
    id: 'email',
    label: '邮箱',
    severity: 'high',
    regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g,
    boundary: 'alnum',
    priority: 80,
    validate: () => true,
    validOnly: true,
  },
  {
    id: 'cn_plate',
    label: '车牌号',
    severity: 'medium',
    regex: /[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼][A-HJ-NP-Z](?:[A-HJ-NP-Z0-9]{5}|[A-HJ-NP-Z0-9]{6})/g,
    boundary: 'alnum',
    priority: 75,
    validate: () => true,
    validOnly: true,
  },
  {
    id: 'ipv4',
    label: 'IP 地址',
    severity: 'medium',
    regex: /\d{1,3}(?:\.\d{1,3}){3}/g,
    boundary: 'alnum',
    priority: 70,
    validate: validIPv4,
    validOnly: false,
  },
  {
    id: 'cn_address',
    label: '地址',
    severity: 'high',
    regex: /(?:[\u4e00-\u9fa5]{2,7}?(?:省|自治区|特别行政区))?[\u4e00-\u9fa5]{2,7}?(?:市|自治州|地区)[\u4e00-\u9fa5]{2,7}?(?:区|县|旗|市)(?:[\u4e00-\u9fa5]{2,15}?(?:路|街|道|巷|村|镇|乡|庄|园|苑|广场|大厦|花园|小区))?[\u4e00-\u9fa5A-Za-z0-9]{0,12}?(?:号|栋|幢|单元|室|楼)/g,
    boundary: 'none',
    priority: 68,
    validate: () => true,
    validOnly: true,
  },
  {
    id: 'cn_landline',
    label: '座机号',
    severity: 'medium',
    regex: /0\d{2,3}[-－ ]?\d{7,8}/g,
    boundary: 'digit',
    priority: 60,
    validate: () => true,
    validOnly: true,
  },
  {
    id: 'cn_name_kw',
    label: '姓名',
    severity: 'high',
    // 中文人名没有可靠的形态特征，只能靠「字段名 + 值」这种强上下文。
    // 连接符可以是冒号，也可以是「为 / 是 / 系」（「联系人为王芳」）；
    // 负向前瞻排除「甲方指定…」这类描述句，否则会把动词当成人名。
    regex: new RegExp(
      `(?:${NAME_KEYWORDS})\\s*[:：为是系]?\\s*(?!(?:${NAME_STOP_PREFIX}))([\\u4e00-\\u9fa5]{2,4})`,
      'g'
    ),
    boundary: 'none',
    priority: 66,
    captureGroup: 1,
    trim: trimName,
    validate: (m, text, start, end) => {
      // 称谓后面跟「先生/女士」这类不是名字
      if (/^(先生|女士|小姐|同志|经理|主任|老师|医生|本人|签字|盖章|签章)$/.test(m)) return false;
      // 取到的本身就是机构词或指代虚词，说明这不是人名（「甲方为公司」）
      if (/^(公司|单位|集团|银行|医院|学校|上述|下列|以下|其他|其余|我方|你方|他方)/.test(m)) return false;
      // 往后看一段：如果构成「若干中文 + 机构后缀」，说明这里是公司名而不是人名
      // 后缀列表刻意不含裸「公司」，否则「张伟先生在公司负责…」会被误排除
      const tail = text.slice(end, end + 26);
      if (/^[\u4e00-\u9fa5A-Za-z0-9（）()·]{0,24}?(?:股份有限公司|有限责任公司|有限公司|集团|银行|支行|分行|医院|学校|大学|学院|事务所|研究院|工厂|超市|酒店|中心)/.test(tail)) {
        return false;
      }
      return true;
    },
    validOnly: true,
  },
  {
    id: 'cn_org_kw',
    label: '单位名称（字段触发）',
    severity: 'medium',
    // 字段名本身足够强，值不做后缀要求，避免「开票抬头：XX科技」漏检
    regex: /(?:公司名称|单位名称|开票抬头|发票抬头|收款单位|付款单位|开户行|开户银行|工作单位)\s*[:：]?\s*([\u4e00-\u9fa5A-Za-z0-9（）()·]{2,30})/g,
    boundary: 'none',
    priority: 55,
    captureGroup: 1,
    validate: () => true,
    validOnly: true,
  },
  {
    id: 'cn_org',
    label: '机构名称（泛匹配）',
    severity: 'medium',
    regex: /[\u4e00-\u9fa5A-Za-z0-9（）()]{2,30}?(?:股份有限公司|有限责任公司|有限公司|集团|银行|支行|分行|医院|诊所|学校|大学|学院|事务所|研究院|工作室|工厂|厂|超市|酒店)/g,
    boundary: 'none',
    priority: 40,
    validate: () => true,
    validOnly: true,
  },
  {
    id: 'social_id',
    label: '账号/微信/QQ',
    severity: 'medium',
    regex: /(?:微信号?|QQ|qq|账号|帐号|卡号|工号|学号|订单号|快递单号|运单号|保单号|合同编号)\s*[:：]?\s*([A-Za-z0-9_-]{5,32})/g,
    boundary: 'none',
    priority: 62,
    captureGroup: 1,
    validate: () => true,
    validOnly: true,
  },
];

/** 按 id 取规则 */
export function getRule(id) {
  return RULES.find((r) => r.id === id) || null;
}

/** 默认启用的规则（机构名称误报偏多，默认关） */
export const DEFAULT_ENABLED = RULES.filter((r) => r.id !== 'cn_org').map((r) => r.id);

/* ------------------------------------------------------------------ *
 * 识别主流程
 * ------------------------------------------------------------------ */

/**
 * @param {string} text
 * @param {object} opts
 * @param {string[]} opts.enabled  启用的规则 id 列表
 * @param {boolean}  opts.strictOnly 仅返回校验通过的（默认 false）
 * @returns {Array<{id,label,severity,start,end,raw,valid,priority}>}
 */
export function detect(text, opts = {}) {
  if (!text) return [];
  const enabled = new Set(opts.enabled || DEFAULT_ENABLED);
  const candidates = [];

  for (const rule of RULES) {
    if (!enabled.has(rule.id)) continue;
    const re = new RegExp(rule.regex.source, 'g');
    let m;
    let guard = 0;
    while ((m = re.exec(text)) !== null) {
      if (guard++ > 200000) break;
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      // 有捕获组时，以捕获组为命中区间
      let start;
      let raw;
      if (rule.captureGroup) {
        const cap = m[rule.captureGroup];
        if (!cap) continue;
        const offset = m[0].indexOf(cap, rule.captureGroup === 1 ? 1 : 0);
        start = m.index + (offset >= 0 ? offset : 0);
        raw = cap;
      } else {
        start = m.index;
        raw = m[0];
      }
      const end0 = start + raw.length;

      if (!boundaryOk(text, start, end0, rule.boundary)) continue;

      // 允许规则修正匹配范围：中文人名用 {2,4} 贪婪匹配会吃掉后面的动词，
      // 例如「联系人张伟负责后续」会被读成「张伟负责」。
      let end = end0;
      if (rule.trim) {
        const t = rule.trim(raw, text, start, end0);
        if (typeof t === 'string' && t.length >= 2 && t !== raw) {
          raw = t;
          end = start + t.length;
        }
      }
      if (!raw) continue;

      let valid = false;
      try {
        valid = rule.validate ? rule.validate(raw, text, start, end) : true;
      } catch {
        valid = false;
      }
      // validOnly 的规则必须通过校验才采纳
      if (rule.validOnly && !valid) continue;

      candidates.push({
        id: rule.id,
        label: rule.label,
        severity: rule.severity,
        start,
        end,
        raw,
        valid,
        priority: valid ? rule.priority : rule.priority - 30,
      });
    }
  }

  return assignKeys(resolveOverlaps(candidates));
}

/** 为每个命中项分配稳定 key：类型 + 原文 + 第几次出现
 *  这样用户局部修改文本后，「遮盖/保留」的选择仍然有效 */
function assignKeys(list) {
  const counts = new Map();
  for (const f of list) {
    const base = `${f.id}|${f.raw}`;
    const n = counts.get(base) || 0;
    counts.set(base, n + 1);
    f.key = `${base}#${n}`;
  }
  return list;
}

/** 冲突消解：优先级高 > 更长 > 靠前；贪心选取互不重叠的区间 */
function resolveOverlaps(list) {
  const sorted = [...list].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    if (b.end - b.start !== a.end - a.start) return b.end - b.start - (a.end - a.start);
    return a.start - b.start;
  });

  const taken = [];
  const kept = [];
  for (const c of sorted) {
    const clash = taken.some((t) => c.start < t.end && c.end > t.start);
    if (!clash) {
      kept.push(c);
      taken.push({ start: c.start, end: c.end });
    }
  }
  return kept.sort((a, b) => a.start - b.start);
}

/* ------------------------------------------------------------------ *
 * 脱敏策略
 * ------------------------------------------------------------------ */

/** 按类型保留可读结构的部分遮盖 */
function partialMask(raw, id) {
  switch (id) {
    case 'cn_id':
      return raw.slice(0, 6) + '*'.repeat(raw.length - 10) + raw.slice(-4);
    case 'cn_mobile':
      return raw.slice(0, 3) + '****' + raw.slice(-4);
    case 'bank_card':
      return raw.slice(0, 4) + '*'.repeat(Math.max(0, raw.length - 8)) + raw.slice(-4);
    case 'email': {
      const [name, domain] = raw.split('@');
      const head = name.length <= 1 ? '*' : name[0] + '*'.repeat(Math.min(name.length - 1, 4));
      return head + '@' + domain;
    }
    case 'cn_name_kw':
      if (raw.length === 2) return raw[0] + '*';
      return raw[0] + '*'.repeat(raw.length - 2) + raw[raw.length - 1];
    case 'cn_address':
      return raw.slice(0, 6) + '*'.repeat(Math.max(0, raw.length - 6));
    case 'cn_plate':
      return raw.slice(0, 2) + '*'.repeat(Math.max(0, raw.length - 4)) + raw.slice(-2);
    case 'cn_landline':
      return raw.slice(0, 3) + '****' + raw.slice(-4);
    case 'ipv4':
      return raw.replace(/\d+$/, '*');
    default:
      return raw.length <= 2 ? '**' : raw[0] + '*'.repeat(raw.length - 2) + raw.slice(-1);
  }
}

/* ------------------------------------------------------------------ *
 * 占位符与映射表
 * ------------------------------------------------------------------ */

/** 规则显示名里可能带括号说明，占位符里只取主名 */
function shortLabel(label) {
  return label.split(/[（(]/)[0].trim();
}

/** 同一类型 + 同一原文 → 同一个占位符。
 *  张三在文中出现两次，都是〔姓名1〕，而不是〔姓名1〕〔姓名2〕——
 *  否则读者会以为是两个人，还原也会错。 */
function groupKey(f) {
  return `${f.id}|${f.raw}`;
}

/**
 * 生成映射表（同一原文只出现一条）
 * @returns {Array<{id,label,type,value,token,count}>}
 */
export function buildMapping(findings) {
  const groups = new Map();
  for (const f of findings) {
    const g = groupKey(f);
    if (!groups.has(g)) {
      groups.set(g, {
        id: f.id,
        label: f.label,
        type: shortLabel(f.label),
        value: f.raw,
        count: 0,
      });
    }
    groups.get(g).count += 1;
  }

  const counters = new Map();
  const out = [];
  for (const item of groups.values()) {
    const n = (counters.get(item.type) || 0) + 1;
    counters.set(item.type, n);
    out.push({ ...item, token: `〔${item.type}${n}〕` });
  }
  return out;
}

/** 从映射表建立 分组键 → 占位符 的查找表 */
function tokenLookup(mapping) {
  const m = new Map();
  for (const item of mapping) m.set(`${item.id}|${item.value}`, item.token);
  return m;
}

/**
 * 生成脱敏文本
 * @param {string} text
 * @param {Array} findings detect() 的结果
 * @param {object} opts
 * @param {'partial'|'full'|'token'} opts.mode
 * @param {Set<string>} opts.skipped  用户选择「保留」的 finding key 集合
 */
export function applyMask(text, findings, opts = {}) {
  const mode = opts.mode || 'partial';
  const skipped = opts.skipped || new Set();
  const lookup = tokenLookup(buildMapping(findings));
  let out = '';
  let cursor = 0;

  findings.forEach((f) => {
    if (f.start < cursor) return;
    const key = f.key || `${f.start}:${f.end}`;
    const original = text.slice(f.start, f.end);
    out += text.slice(cursor, f.start);
    if (skipped.has(key)) {
      out += original;
    } else if (mode === 'full') {
      out += '█'.repeat(Math.max(2, original.length));
    } else if (mode === 'token') {
      out += lookup.get(groupKey(f)) || '〔敏感信息〕';
    } else {
      out += partialMask(original, f.id);
    }
    cursor = f.end;
  });
  out += text.slice(cursor);
  return out;
}

/* ------------------------------------------------------------------ *
 * 还原
 * ------------------------------------------------------------------ */

const RE_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/** 占位符可能被对方在转发时改成 [] 、【】 或加空格，这里都认 */
function tokenPattern(token) {
  const core = token.replace(/^〔|〕$/g, '').replace(RE_SPECIAL, '\\$&');
  return new RegExp(`[〔\\[【(]\\s*${core}\\s*[〕\\]】)]`, 'g');
}

/**
 * 用映射表把占位符换回原文
 * @param {string} text
 * @param {Array<{token:string,value:string}>} mapping
 * @returns {{text:string, restored:number, missing:number}}
 */
export function restore(text, mapping) {
  if (!text || !mapping?.length) return { text: text || '', restored: 0, missing: 0 };

  // 长的先换，避免 〔姓名1〕 抢掉 〔姓名11〕 的开头
  const entries = [...mapping].sort((a, b) => b.token.length - a.token.length);
  let out = text;
  let restored = 0;

  for (const e of entries) {
    const re = tokenPattern(e.token);
    out = out.replace(re, () => {
      restored += 1;
      return e.value;
    });
  }

  // 文中还剩多少占位符没对上，说明映射表不全
  const left = out.match(/[〔\[【]\s*[\u4e00-\u9fa5]{2,10}\d+\s*[〕\]】]/g);
  return { text: out, restored, missing: left ? left.length : 0 };
}

/* ------------------------------------------------------------------ *
 * CSV 读写（映射表导出 / 导入）
 * ------------------------------------------------------------------ */

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 映射表 → CSV 文本 */
export function mappingToCSV(mapping) {
  const head = '占位符,类型,原文,出现次数';
  const rows = mapping.map((m) => [m.token, m.type, m.value, m.count].map(csvCell).join(','));
  return [head, ...rows].join('\n');
}

/** CSV 文本 → 映射表（宽松：允许只有两列「占位符,原文」） */
export function parseMappingCSV(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];

  const rows = lines.map(parseCSVLine);
  const head = rows[0].map((c) => c.trim());
  const hasHeader = /占位符|token|placeholder/i.test(head[0] || '');
  const body = hasHeader ? rows.slice(1) : rows;

  const iToken = 0;
  let iValue;
  let iType;
  if (hasHeader) {
    iValue = head.findIndex((h) => /原文|value|内容/i.test(h));
    iType = head.findIndex((h) => /类型|type/i.test(h));
    if (iValue < 0) iValue = head.length - 1;
  } else {
    iValue = 1;
    iType = -1;
  }

  return body
    .filter((r) => r.length > iToken && r[iToken])
    .map((r) => ({
      token: r[iToken].trim(),
      value: (r[iValue] ?? '').trim(),
      type: iType >= 0 ? (r[iType] || '').trim() : '',
    }))
    .filter((m) => m.token && m.value);
}

/** 解析一行 CSV（支持引号包裹与转义引号） */
function parseCSVLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += c;
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/** 统计各类型命中数，用于结果摘要 */
export function summarize(findings) {
  const map = new Map();
  for (const f of findings) {
    map.set(f.label, (map.get(f.label) || 0) + 1);
  }
  return [...map.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);
}
