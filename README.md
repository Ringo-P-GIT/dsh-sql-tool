# dsh-sql-tool

SQL(含 `@` 宏)与 JSON 的格式化 / 校验 / 自动修复工具,深度支持致远 OA 风格的自定义宏语法。

## 特性

- **格式化** — 关键字大写、子句换行;长 SELECT 列表一列一行,CASE 表达式展开 `WHEN / ELSE`;嵌套宏体逐层下沉
- **括号不堆阶梯** — 缩进只统计含子查询的括号,ORM 常见的 `(((((` 纯分组括号不再逐层累加(实测最大缩进 32 → 8 列)
- **反引号标识符** — `` `db`.`table` `` 整体识别为一个标识符,不会被拆成 `` ` db`.` table` ``
- **校验** — 括号配对、引号闭合、`@` 函数参数个数、未注册函数告警
- **自动修复(fix)** — 三级优先级自动补缺:缺左括号 `(` → `,ELSE'` 漏闭合 `)` → 最外层宏收尾 `)`
- **安全闸门** — `formatSafe`:去空白等价性校验,格式化会改动内容时自动退回原文
- **快速模式** — `validate:false` 跳过一切验证/修复,只做格式化,零诊断
- **字节级原样** — 值宏分隔符(`,` `,ELSE)`)与 `@sqlset` 尾部参数逐字保留,不重排
- **启发式诊断** — 引号未闭合时回溯检测 `=@macro(...)'` 模式,提示「缺开引号」而非笼统的「行尾补引号」
- **替换(replace)** — 按宏文本精确匹配做批量替换
- **JSON** — 格式化 / 校验 / 替换

## 支持的宏

函数清单从 `C:\Users\<user>\.dsh\sql-tool-functions.json` 加载(缺失时降级:未知函数不告警)。

```json
{ "functions": [ { "name": "@form", "params": 2 } ] }
```

常见宏:`@form(表,字段)` / `@nullValue(查询,ELSE)` / `@sqlvalue(查询)` / `@sqlset(语句)` / `@getDeptCode(查询,层级)` / `@processId()` / `@ifThen(条件,真,假,…)`

## 快速上手

```js
const engine = require('./core/engine.cjs');

// 格式化 + 自动修复(fix 模式)
const r = engine.process({
  text: "@sqlset(select a.APPROVER from t where a.dept ='@getDeptCode(@form(X,Y),1)')",
  mode: 'fix',
  funcList: [{ name: '@form', params: 2 }, { name: '@getDeptCode', params: 2 }],
});
console.log(r.formatted);   // 修复+格式化后的 SQL
console.log(r.formatSafe);  // 格式化是否安全(否则已退回原文)
console.log(r.diff);        // 每处修复的前后文

// 快速模式:不验证、不修复,直接格式化
const fast = engine.process({ text: sql, mode: 'format', validate: false });

// 仅校验
const diag = engine.process({ text: sql, mode: 'validate' }).diagnostics;
```

## 排版示例

输入(单行,含 ORM 生成的冗余分组括号):

```sql
select `a`.`id`,`a`.`name`,`a`.`project_number`,(case `a`.`state` when '1' then '研发阶段' when '2' then '立项阶段' when '6' then '开发中' else NULL end) as `state` from (((`demo`.`project` `a` left join `demo`.`staff` `b` on((`a`.`id` = `b`.`pid`))) left join `demo`.`org` `c` on((`a`.`oid` = `c`.`id`)))) where `a`.`type` in ('1','6')
```

输出:

```sql
SELECT
    `a`.`id`,
    `a`.`name`,
    `a`.`project_number`,
    (CASE `a`.`state`
        WHEN '1' THEN '研发阶段'
        WHEN '2' THEN '立项阶段'
        WHEN '6' THEN '开发中'
        ELSE NULL
    END) AS `state`
FROM (((`demo`.`project` `a`
LEFT JOIN `demo`.`staff` `b` ON ((`a`.`id` = `b`.`pid`)))
LEFT JOIN `demo`.`org` `c` ON ((`a`.`oid` = `c`.`id`))))
WHERE `a`.`type` IN ('1', '6')
```

> 拆行都带**宽度闸门**(阈值 `INLINE_MAX = 72` 字符):短查询、短 CASE 保持紧凑,不会被机械拆碎。

## 目录结构

```
core/engine.cjs      引擎:lexer / formatter / validators / autofix / JSON
core/test.cjs        测试套件(node core/test.cjs,87 用例)
core/fmt-sample.cjs  格式化示例
samples/            真实业务 SQL 样例
RENDER-SPEC.md      渲染规范(配色权威,引擎只产出纯文本+token 类型)
docs/DEBUG-NOTES.md 排查笔记:三个「表面能用」的 bug(报错/变形/沉默)
```

## 测试

```bash
node core/test.cjs
# 结果: 87 通过, 0 失败
```

## 设计要点

- 词法层把宏(`@xxx(...)`)解析成带内部结构的 MACRO token(`parts[]` / `segs[]`),格式化与渲染共用同一棵树
- `@form(...)` 是纯参数绑定占位,渲染时整块专色橙,不参与下沉
- `@sqlset` 语句级展开多行;尾部分隔符参数(`, ` 及 `)`)原文重建,绝不重排
- **格式化不删除任何 token** —— `fix` 模式靠「去空白后逐字比对」做安全闸门(`formatSafe`),删字符会让闸门永远失败。所以 ORM 生成的冗余分组括号会**原样保留**(只是不再累加缩进);要彻底拍平,请先清理源 SQL
