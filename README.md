# dsh-sql-tool

SQL(含 `@` 宏)与 JSON 的格式化 / 校验 / 自动修复工具,深度支持致远 OA 风格的自定义宏语法。

## 特性

- **格式化** — 多层缩进、关键字大写,嵌套宏体逐层下沉
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
const engine = require('./core/engine.js');

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

## 目录结构

```
core/engine.js      引擎:lexer / formatter / validators / autofix / JSON
core/test.js        测试套件(node core/test.js,88+ 用例)
core/fmt-sample.js  格式化示例
samples/            真实业务 SQL 样例
RENDER-SPEC.md      渲染规范(配色权威,引擎只产出纯文本+token 类型)
```

## 测试

```bash
node core/test.js
# 结果: N 通过, 0 失败
```

## 设计要点

- 词法层把宏(`@xxx(...)`)解析成带内部结构的 MACRO token(`parts[]` / `segs[]`),格式化与渲染共用同一棵树
- `@form(...)` 是纯参数绑定占位,渲染时整块专色橙,不参与下沉
- `@sqlset` 语句级展开多行;尾部分隔符参数(`, ` 及 `)`)原文重建,绝不重排
