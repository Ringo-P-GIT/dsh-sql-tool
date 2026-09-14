'use strict';
/* dsh-sql-core 单测:需求稿 §8 T5 变异用例 + T3 粘连 12 处 + §4.1 示例 + JSON/替换 */
const eng = require('./engine');
const { process, lex, format, replaceAll, extractMacros, DEFAULT_FUNCS, buildFuncMap } = eng;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '\n    → ' + JSON.stringify(extra) : '')); }
}
function countDiag(diags, rule, level) {
  return diags.filter(d => d.rule === rule && (!level || d.level === level)).length;
}

console.log('=== T5 变异用例 ===');

// 1. 缺左括号
{
  const r = process({ text: "@formXXX,XXX)", mode: 'validate', funcList: DEFAULT_FUNCS });
  const hit = r.diagnostics.find(d => d.rule === 'atfunc' && /缺/.test(d.message));
  check('T5-1 @formXXX,XXX) → 缺左括号', !!hit, r.diagnostics);
}

// 2. 缺右括号
{
  const r = process({ text: "@form(XXX,XXX", mode: 'validate', funcList: DEFAULT_FUNCS });
  const hit = r.diagnostics.find(d => d.rule === 'atfunc' && /闭合/.test(d.message));
  check('T5-2 @form(XXX,XXX → 缺右括号', !!hit, r.diagnostics);
}

// 3. 括号不配对
{
  const r = process({ text: 'select ((a from t', mode: 'validate', funcList: DEFAULT_FUNCS });
  const hit = r.diagnostics.filter(d => d.rule === 'paren');
  check('T5-3 select ((a from t → 括号不配对', hit.length >= 1, r.diagnostics);
}

// 4. 未注册函数 → 警告(清单加载时)
{
  const r = process({ text: "@unknown('x')", mode: 'validate', funcList: DEFAULT_FUNCS });
  const hit = r.diagnostics.find(d => d.rule === 'atfunc' && d.level === 'warn' && /未注册/.test(d.message));
  check('T5-4 @unknown(...) → 警告', !!hit, r.diagnostics);
}

// 5. 0 参函数给了参数
{
  const r = process({ text: '@processId(x)', mode: 'validate', funcList: DEFAULT_FUNCS });
  const hit = r.diagnostics.find(d => d.rule === 'atfunc' && d.level === 'error' && /参数个数/.test(d.message));
  check('T5-5 @processId(x) → 参数个数异常', !!hit, r.diagnostics);
}

// 6. 粘连
{
  const r = process({ text: 'SELECT g.org_numberFROM BO_EU_FIN_DIVISION g', mode: 'validate', funcList: DEFAULT_FUNCS });
  const hit = r.diagnostics.find(d => d.rule === 'concatenation');
  check('T5-6 g.org_numberFROM → 粘连', !!hit, r.diagnostics);
}

// 7. 纯 SQL 无 @ 诊断
{
  const r = process({ text: 'SELECT a,b FROM t WHERE a = 1', mode: 'format', funcList: DEFAULT_FUNCS });
  const noAt = r.diagnostics.every(d => d.rule !== 'atfunc');
  check('T5-7 纯 SQL 无 @ 诊断', noAt, r.diagnostics);
}

// 8. 字符串内逗号不误判为参数分隔
{
  const r = process({ text: "@form(A,'x,y')", mode: 'validate', funcList: DEFAULT_FUNCS });
  const m = r.macros.find(m => m.text === "@form(A,'x,y')");
  check('T5-8 @form(A,\'x,y\') 参数=2', !!m && m.params === 2, r.macros);
}

// 9. 大小写不敏感 + 原文保留
{
  const r = process({ text: "@Sqlvalue(select 1)", mode: 'format', funcList: DEFAULT_FUNCS });
  const m = r.macros.find(m => m.name === '@Sqlvalue');
  const noParamErr = r.diagnostics.every(d => !/参数个数/.test(d.message));
  check('T5-9 @Sqlvalue 大小写不敏感且无参数错误', !!m && noParamErr, r.diagnostics);
  check('T5-9b 原文保留 @Sqlvalue( 大小写', r.formatted.includes('@Sqlvalue('), r.formatted);
}

console.log('=== T3 粘连 12 处 ===');
{
  const t3 = [
    "SELECT g.org_numberFROM BO_EU_FIN_DIVISION g WHERE gWHERE a = 1",
    "SELECT x.numberFROM qsales.project x WHERE xWHERE b = 2",
    "SELECT g.org_numberFROM t1 g WHERE gWHERE c = 3",
    "SELECT x.numberFROM t2 x WHERE xWHERE d = 4",
    "SELECT g.org_numberFROM t3 g WHERE gWHERE e = 5",
    "SELECT x.numberFROM t4 x WHERE xWHERE f = 6",
  ].join('\n');
  const r = process({ text: t3, mode: 'validate', funcList: DEFAULT_FUNCS });
  const concat = r.diagnostics.filter(d => d.rule === 'concatenation');
  check('T3 恰好 12 处粘连', concat.length === 12, concat.map(c => c.message));
  // 按"粘连片段"计数:org_numberFROM / numberFROM / gWHERE / xWHERE 各 3 处
  const byPattern = {};
  for (const c of concat) {
    const m = /"(\w+)" → "(\w+) (\w+)"/.exec(c.message);
    if (m) byPattern[m[1]] = (byPattern[m[1]] || 0) + 1;
  }
  check('T3 四类片段各 3 处(org_numberFROM/numberFROM/gWHERE/xWHERE)',
    byPattern['org_numberFROM'] === 3 && byPattern['numberFROM'] === 3 &&
    byPattern['gWHERE'] === 3 && byPattern['xWHERE'] === 3,
    byPattern);
  // 全部为错误级别
  check('T3 全部 level=error', concat.every(c => c.level === 'error'), concat.map(c => c.level));
}

console.log('=== §4.1 示例格式化冒烟 ===');
{
  const sample = `SELECT a.APPROVER\nFROM BO_EU_FIN_DIVISION a\nWHERE a.company = '@nullValue(@sqlvalue(SELECT f.name FROM qsales.project r WHERE r.id = '@form(BO_EU_CONTRACT_FULFILLMENT,PROJECTID)'), ELSE)'`;
  const r = process({ text: sample, mode: 'format', funcList: DEFAULT_FUNCS });
  check('示例格式化后包含展开宏文本', r.formatted.includes('@nullValue(') && r.formatted.includes('@sqlvalue('), r.formatted);
  check('示例格式化后保留 @form 原文', r.formatted.includes("@form(BO_EU_CONTRACT_FULFILLMENT,PROJECTID)"), r.formatted);
  check('示例格式化后保留 ELSE', r.formatted.includes('ELSE'), r.formatted);
  check('示例格式化后关键字大写 SELECT/FROM/WHERE', /SELECT/.test(r.formatted) && /FROM/.test(r.formatted) && /WHERE/.test(r.formatted), r.formatted);
  check('示例格式化后保留单引号', r.formatted.includes("'") && r.formatted.includes("'@nullValue("), r.formatted);
  check('示例格式化后宏参数空白保留(project r)', r.formatted.includes('qsales.project r'), r.formatted);
}

console.log('=== §4.1 完整样例逐字比对(需求稿目标输出) ===');
{
  const Q = "'";
  // 三级嵌套:@nullValue( @sqlvalue( ... @sqlvalue( ... @form(...) , @Sqlvalue(...) ) ) , ELSE )
  const input = "SELECT a.APPROVER FROM BO_EU_FIN_DIVISION a WHERE a.company = "
    + Q + "@nullValue(@sqlvalue(SELECT DISTINCT a.company FROM BO_EU_FIN_DIVISION a WHERE a.company = "
    + Q + "@sqlvalue(SELECT f.name FROM qsales.project r LEFT JOIN qsales.belong_company f ON r.belong_company_id = f.id WHERE r.id = "
    + Q + "@form(BO_EU_CONTRACT_FULFILLMENT,PROJECTID)" + Q
    + ", @Sqlvalue(SELECT b.code FROM BO_EU_CCDATABASE b WHERE b.name = " + Q + "MOFFI" + Q + ")"
    + ")" + Q
    + ")"
    + ", ELSE)" + Q;
  const target = [
    "SELECT a.APPROVER",
    "FROM BO_EU_FIN_DIVISION a",
    "WHERE a.company = " + Q + "@nullValue(",
    "    @sqlvalue(",
    "        SELECT DISTINCT a.company",
    "        FROM BO_EU_FIN_DIVISION a",
    "        WHERE a.company = " + Q + "@sqlvalue(",
    "            SELECT f.name",
    "            FROM qsales.project r",
    "            LEFT JOIN qsales.belong_company f ON r.belong_company_id = f.id",
    "            WHERE r.id = " + Q + "@form(BO_EU_CONTRACT_FULFILLMENT,PROJECTID)" + Q + ",",
    "            @Sqlvalue(SELECT b.code FROM BO_EU_CCDATABASE b WHERE b.name = " + Q + "MOFFI" + Q + ")",
    "        )" + Q,
    "    ), ELSE)" + Q,
  ].join("\n");
  const r = process({ text: input, mode: 'format', funcList: DEFAULT_FUNCS });
  check('§4.1 完整样例零诊断', r.diagnostics.length === 0, r.diagnostics);
  if (r.formatted !== target) {
    const a = r.formatted.split("\n"), b = target.split("\n");
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) console.log('    差异@' + i + ' 实际=' + JSON.stringify(a[i]) + ' 期望=' + JSON.stringify(b[i]));
    }
  }
  check('§4.1 输出与需求稿目标逐字一致', r.formatted === target, r.formatted);
  check('§4.1 LEFT JOIN ... ON 保持同行', r.formatted.includes("LEFT JOIN qsales.belong_company f ON r.belong_company_id = f.id"), r.formatted);
  check('§4.1 叶子宏 @Sqlvalue(...) 保持一行', r.formatted.includes("@Sqlvalue(SELECT b.code FROM BO_EU_CCDATABASE b WHERE b.name = 'MOFFI')"), r.formatted);
  check('§4.1 短尾合并 ), ELSE) 同行', r.formatted.includes("    ), ELSE)" + Q), r.formatted);
  check('§4.1 APPROVER 不误报粘连', !r.diagnostics.some(d => d.rule === 'concatenation'), r.diagnostics);
}

console.log('=== @sqlset 分隔符保留 ===');
{
  const r = process({ text: "SELECT 1 FROM DUAL WHERE a = '@sqlset(sql, )'", mode: 'format', funcList: DEFAULT_FUNCS });
  check('@sqlset(sql, ) 原文保留(含逗号后空格)', r.formatted.includes("@sqlset(sql, )"), r.formatted);
  const r2 = process({ text: "SELECT 1 FROM DUAL WHERE a = '@sqlset(sql,;)'", mode: 'format', funcList: DEFAULT_FUNCS });
  check('@sqlset(sql,;) 原文保留', r2.formatted.includes("@sqlset(sql,;)"), r2.formatted);
}

console.log('=== 宏提取(去重+计数) ===');
{
  const r = process({ text: "SELECT '@form(A,B)' x FROM t WHERE c = '@form(A,B)' AND d = '@sqlvalue(SELECT 1)'", mode: 'validate', funcList: DEFAULT_FUNCS });
  const f = r.macros.find(m => m.text === '@form(A,B)');
  const s = r.macros.find(m => m.text.startsWith('@sqlvalue('));
  check('去重计数 @form(A,B) ×2', !!f && f.count === 2, r.macros);
  check('@sqlvalue 提取 1 个', !!s && s.count === 1, r.macros);
}

console.log('=== JSON ===');
{
  const ok = process({ text: '{"a":1,"b":[1,2]}', language: 'json', mode: 'format' });
  check('JSON 格式化 2 空格缩进', ok.formatted === '{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}', ok.formatted);
  const bad = process({ text: '{"a":}', language: 'json', mode: 'validate' });
  check('JSON 非法 → 诊断', bad.diagnostics.length >= 1, bad.diagnostics);
  check('JSON 非法 → 行列号', bad.diagnostics[0] && bad.diagnostics[0].line >= 1, bad.diagnostics);
}

console.log('=== 替换 ===');
{
  const src = "SELECT '@form(A,B)' FROM t";
  const quoted = replaceAll(src, [{ find: '@form(A,B)', value: 'A101' }], { quoted: true });
  check('带引号替换', quoted === "SELECT 'A101' FROM t", quoted);
  const unquoted = replaceAll(src, [{ find: '@form(A,B)', value: 'A101' }], { quoted: false });
  check('不带引号替换', unquoted === "SELECT 'A101' FROM t" || unquoted.includes('A101'), unquoted);
}

console.log('=== 降级:无函数清单 ===');
{
  const r = process({ text: '@unknown(x)', mode: 'validate', funcList: null });
  const noWarn = !r.diagnostics.some(d => d.rule === 'atfunc');
  check('无清单时未知函数不告警', noWarn, r.diagnostics);
}

console.log('=== 参数范围校验 ===');
{
  const r = process({ text: '@avg(1)', mode: 'validate', funcList: DEFAULT_FUNCS });
  const hit = r.diagnostics.find(d => d.rule === 'atfunc' && /avg/.test(d.message));
  check('@avg(1) 少于 2 参 → 报错', !!hit, r.diagnostics);
  const r2 = process({ text: '@avg(1,2,3)', mode: 'validate', funcList: DEFAULT_FUNCS });
  check('@avg(1,2,3) 合法', r2.diagnostics.every(d => d.rule !== 'atfunc'), r2.diagnostics);
}

console.log('=== 紧凑模式 ===');
{
  const r = process({ text: "SELECT a FROM t WHERE a = '@nullValue(@sqlvalue(SELECT 1),ELSE)'", mode: 'format', options: { compact: true } });
  const lines = r.formatted.split('\n');
  check('紧凑模式单行', lines.length === 1, r.formatted);
  check('紧凑模式保留宏文本与引号', /\('@nullValue\(@sqlvalue\(SELECT 1\), ?ELSE\)'\)/.test(r.formatted) || r.formatted.includes("@nullValue(@sqlvalue(SELECT 1), ELSE)"), r.formatted);
}

console.log('=== 校验行列号精度 ===');
{
  const r = process({ text: "SELECT x.numberFROM t\nFROM t2", mode: 'validate', funcList: DEFAULT_FUNCS });
  const c = r.diagnostics.find(d => d.rule === 'concatenation');
  // "SELECT x.numberFROM" → number 起于 col 10,FROM 起于 col 16
  check('numberFROM 粘连定位 col=16(缺失空格处)', !!c && c.line === 1 && c.col === 16, c);
}

console.log('=== MySQL 会话变量(@i / @f)不误报 ===');
{
  const r = process({ text: 'SELECT *, (@i:=@i + 1) AS rows FROM t', mode: 'format', funcList: DEFAULT_FUNCS });
  check('@i:= 不报 atfunc', r.diagnostics.length === 0, r.diagnostics);
  check(':= 冒号未被吞', r.formatted.includes('@i := @i + 1'), r.formatted);
  const r2 = process({ text: 'SELECT @f FROM t', mode: 'validate', funcList: DEFAULT_FUNCS });
  check('单字符 @f 视为会话变量', r2.diagnostics.length === 0, r2.diagnostics);
  const r3 = process({ text: 'SELECT x FROM t WHERE a = @getDeptCode x)', mode: 'validate', funcList: DEFAULT_FUNCS });
  check('真·残缺宏仍需告警(缺左括号且行内有 ))', r3.diagnostics.some(d => d.rule === 'atfunc'), r3.diagnostics);
}

console.log('=== @sqlset 分隔符(第二参数)语义 ===');
{
  const r = process({ text: "SELECT '@sqlset(sql, )' AS x", mode: 'format', funcList: DEFAULT_FUNCS });
  check('@sqlset(sql, ) 识别为 2 参(分隔符=空格)', r.macros[0] && r.macros[0].params === 2, r.macros);
  check('@sqlset(sql, ) 原文逐字保留', r.formatted.includes("@sqlset(sql, )"), r.formatted);
  const r2 = process({ text: "SELECT '@sqlset(sql,;)' AS x", mode: 'format', funcList: DEFAULT_FUNCS });
  check('@sqlset(sql,;) 识别为 2 参(分隔符=分号)', r2.macros[0] && r2.macros[0].params === 2, r2.macros);
  check('@sqlset(sql,;) 原文逐字保留', r2.formatted.includes("@sqlset(sql,;)"), r2.formatted);
  const r3 = process({ text: '@sqlset(SELECT a FROM t WHERE b = 1, )', mode: 'format', funcList: DEFAULT_FUNCS });
  check('语句级 @sqlset 体是查询 → 展开换行', r3.formatted.split('\n').length > 1, r3.formatted);
  check('@sqlset 尾部分隔符字节级保留(含空格)', r3.formatted.endsWith(', )'), r3.formatted);
  check('@sqlset 体关键字大写', r3.formatted.includes('SELECT a') && r3.formatted.includes('FROM t') && r3.formatted.includes('WHERE b = 1'), r3.formatted);
}

console.log('=== 标识符不被误大写(需求稿 §4.1:字段名保留原样) ===');
{
  const r = process({ text: 'SELECT z.rows, y.rows AS rows FROM t z', mode: 'format', funcList: DEFAULT_FUNCS });
  check('z.rows 保持小写(点号后是标识符)', r.formatted.includes('z.rows'), r.formatted);
  check('AS rows 保持小写(AS 后是别名)', r.formatted.includes('AS rows'), r.formatted);
  check('未出现 ROWS 大写化', !r.formatted.includes('ROWS'), r.formatted);
}

console.log('=== 括号排版(层级缩进 + 短块不拆) ===');
{
  // 宽括号块(单行 > 72 字符)→ 拆行且 ) 回父级缩进
  const wide = 'SELECT * FROM (SELECT alpha, beta, gamma, delta, epsilon, zeta, eta FROM mytable WHERE cond = 1) f';
  const r = process({ text: wide, mode: 'format', funcList: DEFAULT_FUNCS });
  check('宽括号块: ) 回父级缩进独占一行', /\n\) f/.test(r.formatted), r.formatted);
  check('子句随括号层级加深缩进', r.formatted.includes('\n    SELECT alpha'), r.formatted);
  check('括号内 FROM 也带缩进', r.formatted.includes('\n    FROM mytable'), r.formatted);
  // 窄括号块(单行 ≤ 72)→ 不拆
  const r2 = process({ text: 'SELECT * FROM (SELECT a FROM t WHERE b = 1) f WHERE c = (SELECT 1)', mode: 'format', funcList: DEFAULT_FUNCS });
  check('窄括号块整体保持一行', r2.formatted.includes('FROM (SELECT a FROM t WHERE b = 1) f'), r2.formatted);
  check('短子查询 (SELECT 1) 保持一行', r2.formatted.includes('c = (SELECT 1)'), r2.formatted);
  const r3 = process({ text: 'SELECT a, (SELECT b) AS c FROM t', mode: 'format', funcList: DEFAULT_FUNCS });
  check('逗号后接括号补空格', r3.formatted.includes(', ('), r3.formatted);
}

console.log('=== 幂等性(格式化结果再格式化不变) ===');
{
  const files = ['G:/ringo_p_deepseek/dsh-sql-tool/samples/sqlset.sql'];
  for (const f of files) {
    let src;
    try { src = require('fs').readFileSync(f, 'utf8'); } catch (e) { continue; }
    const once = process({ text: src.replace(/\r\n/g, '\n').replace(/\n$/, ''), mode: 'format', funcList: DEFAULT_FUNCS }).formatted;
    const twice = process({ text: once, mode: 'format', funcList: DEFAULT_FUNCS }).formatted;
    check('sqlset 样例幂等', once === twice, { once: once.slice(0, 120), twice: twice.slice(0, 120) });
  }
}

console.log('=== fix 模式(自动补括号) ===');
{
  // F1 缺左括号 → 自动补上,ATBAD 消失
  const r = process({ text: '@formXXX,XXX)', mode: 'fix', funcList: DEFAULT_FUNCS });
  check('F1 缺左括号被自动补上', r.sql.includes('@form(XXX,XXX)'), { sql: r.sql, applied: r.applied });
  check('F1 ATBAD 已清零', !r.diagnostics.some(d => /缺少左括号/.test(d.message)), r.diagnostics);

  // F2 模糊前缀:@formBO_EU_CONTRACT_PURCHASE → @form(BO_EU_CONTRACT_PURCHASE
  const r2 = process({
    text: "SELECT 1 FROM t WHERE a ='@getDeptCode(@formBO_EU_CONTRACT_PURCHASE,DEPTNUM),1)'",
    mode: 'fix', funcList: DEFAULT_FUNCS,
  });
  check('F2 模糊前缀补出 (', r2.sql.includes('@form(BO_EU_CONTRACT_PURCHASE,DEPTNUM)'), r2.sql);
  check('F2 已无 ATBAD', !r2.diagnostics.some(d => /缺少左括号/.test(d.message)), r2.diagnostics);

  // F3 干净输入:一个字都不改
  const clean = 'SELECT a FROM t WHERE b = 1';
  const r3 = process({ text: clean, mode: 'fix', funcList: DEFAULT_FUNCS });
  check('F3 干净输入零改动', r3.sql === clean && r3.applied.length === 0, r3);

  // F4 `,IDENT'` 缺 ) → 精准补在 ' 之前(不是堆到末尾)
  const r4 = process({
    text: "'@nullValue(@sqlvalue(select a.company from T),ELSE'",
    mode: 'fix', funcList: DEFAULT_FUNCS,
  });
  check("F4 ',ELSE' 被补成 ',ELSE)'",
    r4.sql === "'@nullValue(@sqlvalue(select a.company from T),ELSE)'", { sql: r4.sql, applied: r4.applied });

  // F4b 最外层宏缺收尾 ) → 位置确定(必在末尾),补上
  const r4b = process({ text: '@form(XXX,XXX', mode: 'fix', funcList: DEFAULT_FUNCS });
  check('F4b 最外层收尾 ) 被补上', r4b.sql === '@form(XXX,XXX)', { sql: r4b.sql, applied: r4b.applied });

  // F4c 末位不得堆 ) ——修复后 SQL 尾部原样保留
  const r4c = process({
    text: "@x(@nullValue(@sqlvalue(select 1),ELSE' and b ='q')",
    mode: 'fix', funcList: DEFAULT_FUNCS,
  });
  check('F4c 不在文本末尾瞎堆 )', !/\)\)\)/.test(r4c.sql), r4c.sql);

  // F4d 不变量:修复后的错误数绝不高于修复前(修复只许变好,不许改坏)
  const cases = [
    "@nullValue(select 1,ELSE'",
    '@form(XXX,XXX',
    "@x(@nullValue(@sqlvalue(select 1),ELSE' and b ='q')",
    '@formBO_EU_CONTRACT_PURCHASE,DEPTNUM),3)',
    "@getDeptCode(@formBO_EU_CONTRACT_PURCHASE,DEPTNUM),1)",
  ];
  let ok = true, detail = null;
  for (const t of cases) {
    const before = process({ text: t, mode: 'validate', funcList: DEFAULT_FUNCS })
      .diagnostics.filter(d => d.level === 'error').length;
    const r = process({ text: t, mode: 'fix', funcList: DEFAULT_FUNCS });
    const after = r.diagnostics.filter(d => d.level === 'error').length;
    if (after > before) { ok = false; detail = { text: t, before, after, applied: r.applied }; break; }
  }
  check('F4d 不变量:修复不加重病情', ok, detail);

  // F5 修复必须收敛:补完 ( 后不得冒出新的 ATBAD
  const r5 = process({
    text: "SELECT 1 FROM t WHERE a ='@getDeptCode(@formBO_X,DEPTNUM),1)'",
    mode: 'fix', funcList: DEFAULT_FUNCS,
  });
  const before = process({ text: r5.sql, mode: 'validate', funcList: DEFAULT_FUNCS }).diagnostics;
  check('F5 补后复查无新增 ATBAD', !before.some(d => /缺少左括号/.test(d.message)), before);

  // F6 无函数清单也能补(兜底路径)
  const r6 = process({ text: '@formXXX,XXX)', mode: 'fix' });
  check('F6 无清单兜底补 (', r6.sql.includes('@formXXX('), r6.sql);
}

console.log('=== fix 输出项(diff + formatted) ===');
{
  // F7 diff 输出:条数与 applied 一致,每条带 insert/before/after/reason
  const r7 = process({ text: '@formXXX,XXX)', mode: 'fix', funcList: DEFAULT_FUNCS });
  check('F7 diff 与 applied 等长', r7.diff.length === r7.applied.length, r7.diff);
  check('F7 diff 局部前后文可读',
    r7.diff.every(d => d.insert && d.before && d.after && d.before !== d.after && d.reason),
    r7.diff);

  // F8 修复 + 格式化:formatted 必须存在且内容零丢失(去空白后长度差 = 插入字符数)
  const r8 = process({
    text: "SELECT a FROM t WHERE x ='@getDeptCode(@formBO_X,DEPTNUM),1)'",
    mode: 'fix', funcList: DEFAULT_FUNCS,
  });
  const insLen = r8.diff.reduce((n, d) => n + d.insert.length, 0);
  check('F8 formatted 存在', typeof r8.formatted === 'string' && r8.formatted.length > 0);
  check('F8 格式化零丢失文本',
    r8.formatted.replace(/\s+/g, '').length === r8.sql.replace(/\s+/g, '').length && insLen === 1,
    { sql: r8.sql, formatted: r8.formatted });

  // F9 格式化确实执行(语句级 @sqlset 体会展开换行,且尾部分隔符不丢)
  const r9 = process({ text: '@sqlset(select a from t where c = 1,)', mode: 'fix', funcList: DEFAULT_FUNCS });
  check('F9 fix 同时产出格式化结果(含换行)', /\n/.test(r9.formatted), r9.formatted);
  check('F9 尾部分隔符 , 未丢', r9.formatted.replace(/\s+/g, '').endsWith('=1,)'), r9.formatted);

  // F11 宽叶子宏展开多行(新规则:@sqlvalue(长查询) 不再强制一行)
  const wide = "@sqlvalue(select a.APPROVER from BO_EU_FIN_DIVISION a where a.company = 'X')";
  const r11 = process({ text: wide, mode: 'fix', funcList: DEFAULT_FUNCS });
  check('F11 宽 @sqlvalue 展开多行', /\n/.test(r11.formatted) && /@sqlvalue\(/.test(r11.formatted),
    { len: wide.length, formatted: r11.formatted });

  // F12 短叶子宏仍保持一行(66 字符那条 §4.1 样例)
  const short = "@Sqlvalue(SELECT b.code FROM BO_EU_CCDATABASE b WHERE b.name = 'MOFFI')";
  const r12 = process({ text: short, mode: 'fix', funcList: DEFAULT_FUNCS });
  check('F12 短叶子宏保持一行', !/\n/.test(r12.formatted), { len: short.length, formatted: r12.formatted });

  // F13 格式化安全闸门:不安全时必须退回并置 formatSafe=false,绝不改动内容
  const r13 = process({ text: "@x(select a from t where b ='q)", mode: 'fix', funcList: DEFAULT_FUNCS });
  if (r13.formatSafe === false) {
    check('F13 不安全时退回未格式化', r13.formatted === r13.sql, r13.formatted);
  } else {
    check('F13 安全时内容等价',
      r13.formatted.replace(/\s+/g, '').toLowerCase() === r13.sql.replace(/\s+/g, '').toLowerCase(),
      r13.formatted);
  }

  // F14 @sqlset(sql,) 尾逗号无空格 → 分隔符不得丢(回归 bug)
  const r14 = process({ text: '@sqlset(sql,)', mode: 'fix', funcList: DEFAULT_FUNCS });
  check('F14 @sqlset(sql,) 逗号保住', r14.formatted.replace(/\s+/g, '') === '@sqlset(sql,)', r14.formatted);

  // F10 干净输入:formatted 稳定,diff 为空
  const r10 = process({ text: 'SELECT a FROM t', mode: 'fix', funcList: DEFAULT_FUNCS });
  check('F10 干净输入 diff 为空且格式化生效',
    r10.diff.length === 0 && r10.formatted.includes('SELECT a') && r10.formatted.includes('\nFROM t'), r10);

  // F15 缺开引号启发式:validate 模式输出 warn 提示 =@macro(...)' 位置
  const src15 = "@sqlvalue(select x from t where a ='b) and c =@getDeptCode(@form(X,Y),2)'),ELSE)'";
  const r15 = process({ text: src15, mode: 'validate', funcList: DEFAULT_FUNCS });
  const hint = r15.diagnostics.filter(d => /开引号/.test(d.message));
  check('F15 缺开引号启发式命中', hint.length > 0 && hint[0].col > 0, hint);
  // 真·缺关引号不误报
  const r15b = process({ text: "SELECT a FROM t WHERE b = 'abc", mode: 'validate', funcList: DEFAULT_FUNCS });
  check('F15 真缺关引号不误报', !r15b.diagnostics.some(d => /开引号/.test(d.message)), r15b.diagnostics);

  // F16 快速模式 validate:false → 零诊断、零修复,只格式化
  const r16 = process({ text: "select a from t where b='x'", mode: 'format', validate: false, funcList: DEFAULT_FUNCS });
  check('F16 快速模式零诊断且格式化',
    r16.diagnostics.length === 0 && r16.formatted.includes('\nFROM t'), r16);
  // 快速模式对烂输入也不报错(不验证)
  const r16b = process({ text: "select a from t where b ='unclosed", mode: 'format', validate: false, funcList: DEFAULT_FUNCS });
  check('F16 快速模式烂输入零诊断', r16b.diagnostics.length === 0, r16b.diagnostics);
  // 默认仍验证
  const r16c = process({ text: "select a from t where b ='unclosed", mode: 'format', funcList: DEFAULT_FUNCS });
  check('F16 默认模式仍验证', r16c.diagnostics.length > 0, r16c.diagnostics);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0) globalThis.process.exitCode = 1;