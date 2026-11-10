/**
 * 规则引擎测试 —— node --test tests/
 * 覆盖：校验算法、命中、不误报、冲突消解、脱敏输出
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkChineseId,
  luhn,
  checkCreditCode,
  detect,
  applyMask,
  summarize,
  buildMapping,
  restore,
  mappingToCSV,
  parseMappingCSV,
  DEFAULT_ENABLED,
} from '../assets/pii-rules.js';

/* ---------------- 校验算法 ---------------- */

test('身份证校验位', () => {
  assert.equal(checkChineseId('110101199003078515'), true);
  assert.equal(checkChineseId('110101199003078516'), false);
  assert.equal(checkChineseId('11010119900307851'), false);
  assert.equal(checkChineseId('11010119900307851X'), false);
});

test('Luhn 校验', () => {
  assert.equal(luhn('4111111111111111'), true);
  assert.equal(luhn('4111111111111112'), false);
  assert.equal(luhn('6222021234567890123'), false);
});

test('统一社会信用代码校验', () => {
  // 用反算方式构造一个必然合法的代码，避免依赖外部样例
  const CHARS = '0123456789ABCDEFGHJKLMNPQRTUWXY';
  const W = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];
  const body = '91330100' + '79965505' + '8';
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += CHARS.indexOf(body[i]) * W[i];
  const code = body + CHARS[(31 - (sum % 31)) % 31];
  assert.equal(checkCreditCode(code), true);
  assert.equal(checkCreditCode(code.slice(0, 17) + (code[17] === 'B' ? 'C' : 'B')), false);
});

/* ---------------- 命中 ---------------- */

const SAMPLE = `客户姓名：张伟，身份证 110101199003078515，手机 13812345678，
邮箱 zhang.wei@example.com，银行卡 4111111111111111，
住址 广东省深圳市南山区科技园南路18号，车牌 京A12345，
公司 深圳市腾讯计算机系统有限公司。`;

test('常见 PII 全部命中', () => {
  const f = detect(SAMPLE, { enabled: [...DEFAULT_ENABLED, 'cn_org'] });
  const ids = new Set(f.map((x) => x.id));
  for (const id of ['cn_id', 'cn_mobile', 'email', 'bank_card', 'cn_address', 'cn_plate', 'cn_name_kw', 'cn_org']) {
    assert.ok(ids.has(id), `未命中 ${id}`);
  }
});

test('身份证不被误判为银行卡', () => {
  const f = detect('身份证 110101199003078515 结束');
  assert.equal(f.length, 1);
  assert.equal(f[0].id, 'cn_id');
});

test('手机号不被 18 位规则吞掉', () => {
  const f = detect('电话 13812345678 谢谢');
  assert.equal(f.length, 1);
  assert.equal(f[0].raw, '13812345678');
});

/* ---------------- 不误报 ---------------- */

test('普通数字与日期不误报', () => {
  const cases = [
    '2026年11月8日 17:30 开会',
    '单价 1200 元，数量 35 件，合计 42000 元',
    '第 18 条、第 22 项规定',
    '合同共 3 页，附件 12 个，签字页在第 8 页',
    '总分 98.5 分',
    '版本 v2.11.3 已发布',
  ];
  for (const c of cases) {
    const f = detect(c);
    assert.equal(f.length, 0, `误报：${c} -> ${JSON.stringify(f.map((x) => x.raw))}`);
  }
});

test('订单号等编号类按上下文命中', () => {
  const f = detect('订单号 A20261108001 已发货');
  assert.equal(f.length, 1);
  assert.equal(f[0].id, 'social_id');
  assert.equal(f[0].raw, 'A20261108001');
});

test('合同称谓后的人名被识别', () => {
  for (const t of ['甲方：张伟', '乙方:李小明', '承租人：王芳', '患者：刘建国']) {
    const f = detect(t);
    assert.equal(f.length, 1, `${t} -> ${JSON.stringify(f.map((x) => x.raw))}`);
    assert.equal(f[0].id, 'cn_name_kw');
  }
});

test('称谓后跟公司名不被人名规则误吞', () => {
  const f = detect('甲方：深圳市腾讯计算机系统有限公司', {
    enabled: [...DEFAULT_ENABLED, 'cn_org'],
  });
  assert.ok(!f.some((x) => x.id === 'cn_name_kw'), JSON.stringify(f));
  assert.ok(f.some((x) => x.id === 'cn_org'), JSON.stringify(f));
});

test('开票抬头等字段名触发机构识别', () => {
  const f = detect('开票抬头：杭州某某科技有限公司\n开户行：招商银行杭州分行');
  const ids = f.map((x) => x.id);
  assert.ok(ids.includes('cn_org_kw'), JSON.stringify(f));
});

test('称谓后跟称谓词不误判', () => {
  const f = detect('甲方：先生 乙方：经理');
  assert.equal(f.length, 0, JSON.stringify(f.map((x) => x.raw)));
});

test('人名贪婪溢出会被剥掉尾巴', () => {
  const cases = [
    ['联系人张伟负责后续对接', '张伟'],
    ['甲方：张伟先生', '张伟'],
    ['收件人李小明先生', '李小明'],
    ['患者：欧阳修文', '欧阳修文'],
    ['乙方：王芳的助理', '王芳'],
  ];
  for (const [text, expect] of cases) {
    const f = detect(text).filter((x) => x.id === 'cn_name_kw');
    assert.equal(f.length, 1, `${text} -> ${JSON.stringify(f.map((x) => x.raw))}`);
    assert.equal(f[0].raw, expect, `${text} 应为 ${expect}，实际 ${f[0].raw}`);
  }
});

test('「为 / 是」后面跟的是值，要识别', () => {
  for (const [text, expect] of [
    ['联系人为王芳', '王芳'],
    ['负责人是李强', '李强'],
    ['承租方王建国', '王建国'],
  ]) {
    const f = detect(text).filter((x) => x.id === 'cn_name_kw');
    assert.equal(f.length, 1, `${text} -> ${JSON.stringify(f.map((x) => x.raw))}`);
    assert.equal(f[0].raw, expect);
  }
});

test('「甲方为公司」不把人名规则带偏', () => {
  const f = detect('甲方为公司').filter((x) => x.id === 'cn_name_kw');
  assert.equal(f.length, 0, JSON.stringify(f.map((x) => x.raw)));
});

test('字段名后接动词时不算人名字段', () => {
  const f = detect('甲方指定联系人张伟负责后续对接').filter((x) => x.id === 'cn_name_kw');
  assert.equal(f.length, 1, JSON.stringify(f.map((x) => x.raw)));
  assert.equal(f[0].raw, '张伟');
});

test('同一人名在不同上下文中共用同一个占位符', () => {
  const text = '甲方：张伟。联系人张伟负责后续对接，张伟的电话同上。';
  const f = detect(text);
  const out = applyMask(text, f, { mode: 'token' });
  const tokens = out.match(/〔姓名\d+〕/g) || [];
  assert.ok(tokens.length >= 2, out);
  assert.equal(new Set(tokens).size, 1, `出现了多个编号：${out}`);
});

test('无效身份证仍被遮盖但优先级降低', () => {
  const f = detect('号 110101199003078516 结束');
  assert.equal(f.length, 1);
  assert.equal(f[0].valid, false);
  assert.ok(f[0].priority < 100);
});

/* ---------------- 脱敏输出 ---------------- */

test('部分遮盖保留可读结构', () => {
  const f = detect('身份证 110101199003078515 手机 13812345678');
  const out = applyMask('身份证 110101199003078515 手机 13812345678', f, { mode: 'partial' });
  assert.ok(out.includes('110101********8515'), out);
  assert.ok(out.includes('138****5678'), out);
  assert.ok(!out.includes('110101199003078515'));
  assert.ok(!out.includes('13812345678'));
});

test('全遮盖 / 占位符模式', () => {
  const text = '手机 13812345678';
  const f = detect(text);
  assert.ok(!applyMask(text, f, { mode: 'full' }).includes('1381'));
  assert.ok(applyMask(text, f, { mode: 'token' }).includes('手机号1'));
});

test('用户选择保留的项不被遮盖', () => {
  const text = '手机 13812345678 邮箱 a@b.com';
  const f = detect(text);
  const skipped = new Set([f[0].key]);
  const out = applyMask(text, f, { mode: 'partial', skipped });
  assert.ok(out.includes('13812345678'));
  assert.ok(!out.includes('a@b.com'));
});

test('摘要统计', () => {
  const f = detect('手机 13812345678 和 13912345678');
  const s = summarize(f);
  assert.deepEqual(s, [{ label: '手机号', count: 2 }]);
});

/* ---------------- 占位符与映射表 ---------------- */

test('同一原文共用一个占位符', () => {
  const text = '甲方：张伟，乙方：李四，担保人：张伟';
  const f = detect(text);
  const out = applyMask(text, f, { mode: 'token' });
  const zhang = out.match(/〔姓名\d+〕/g) || [];
  const unique = [...new Set(zhang)];
  assert.equal(unique.length, 2, out); // 张伟、李四各一个编号
  assert.equal(zhang.length, 3); // 出现三次
  assert.equal(zhang[0], zhang[2], '同一个张伟必须是同一个占位符');
});

test('不同类型的编号互不干扰', () => {
  const text = '手机 13812345678 另一个手机 13912345678';
  const f = detect(text);
  const mapping = buildMapping(f);
  assert.deepEqual(
    mapping.map((m) => m.token),
    ['〔手机号1〕', '〔手机号2〕']
  );
  assert.equal(mapping[0].count, 1);
});

test('映射表内容正确', () => {
  const text = '甲方：张伟，身份证 110101199003078515，手机 13812345678';
  const mapping = buildMapping(detect(text));
  const name = mapping.find((m) => m.type === '姓名');
  assert.equal(name.value, '张伟');
  assert.equal(name.token, '〔姓名1〕');
  assert.ok(mapping.some((m) => m.value === '110101199003078515'));
});

test('还原能换回原文', () => {
  const text = '甲方：张伟，身份证 110101199003078515，手机 13812345678';
  const f = detect(text);
  const masked = applyMask(text, f, { mode: 'token' });
  const mapping = buildMapping(f);
  assert.ok(!masked.includes('张伟'), masked);

  const r = restore(masked, mapping);
  assert.equal(r.text, text);
  assert.equal(r.restored, 3);
  assert.equal(r.missing, 0);
});

test('还原容忍对方把括号改成方括号或加空格', () => {
  const mapping = [{ token: '〔姓名1〕', value: '张伟' }];
  for (const t of ['甲方：〔姓名1〕', '甲方：【姓名1】', '甲方：[ 姓名1 ]']) {
    assert.equal(restore(t, mapping).text, '甲方：张伟', t);
  }
});

test('还原时长占位符不被短占位符抢走', () => {
  const mapping = [
    { token: '〔姓名1〕', value: '张三' },
    { token: '〔姓名11〕', value: '李四' },
  ];
  const r = restore('甲：〔姓名1〕 乙：〔姓名11〕', mapping);
  assert.equal(r.text, '甲：张三 乙：李四');
  assert.equal(r.restored, 2);
});

test('映射表不全时能报出剩余占位符', () => {
  const text = '甲方：张伟，乙方：李四';
  const f = detect(text);
  const masked = applyMask(text, f, { mode: 'token' });
  const partial = buildMapping(f).slice(0, 1);
  const r = restore(masked, partial);
  assert.equal(r.restored, 1);
  assert.equal(r.missing, 1);
});

test('CSV 往返保持内容', () => {
  const text = '甲方：张伟，公司 深圳市腾讯计算机系统有限公司，手机 13812345678';
  const mapping = buildMapping(detect(text, { enabled: [...DEFAULT_ENABLED, 'cn_org'] }));
  const csv = mappingToCSV(mapping);
  const back = parseMappingCSV(csv);
  assert.equal(back.length, mapping.length);
  for (let i = 0; i < mapping.length; i++) {
    assert.equal(back[i].token, mapping[i].token);
    assert.equal(back[i].value, mapping[i].value);
  }
});

test('CSV 能处理原文里的逗号与引号', () => {
  const mapping = [
    { token: '〔地址1〕', value: 'A栋, 3单元 "顶层"', type: '地址', count: 1 },
  ];
  const back = parseMappingCSV(mappingToCSV(mapping));
  assert.equal(back[0].value, 'A栋, 3单元 "顶层"');
});

test('只给两列的 CSV 也能解析', () => {
  const back = parseMappingCSV('〔姓名1〕,张伟\n〔姓名2〕,李四');
  assert.equal(back.length, 2);
  assert.equal(back[1].value, '李四');
});

/* ---------------- 健壮性 ---------------- */

test('空输入与超长输入不崩', () => {
  assert.deepEqual(detect(''), []);
  assert.deepEqual(detect(null), []);
  const big = '手机 13812345678，'.repeat(2000);
  const t0 = Date.now();
  const f = detect(big);
  const cost = Date.now() - t0;
  assert.equal(f.length, 2000);
  assert.ok(cost < 3000, `性能异常：${cost}ms`);
});
