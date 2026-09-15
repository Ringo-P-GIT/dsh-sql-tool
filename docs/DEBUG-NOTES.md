# 排查笔记 · 三个「表面能用」的 bug

> 2026-09 · DSH 升级到 0.1.5-rc.1 之后的一次完整排查记录
>
> 留档原因：三个 bug 的**失败模式**很有代表性 —— 报错、变形、沉默，越往后越难查。

---

## 一句话总结

`sql_tool` 在面板里一直"正常"，但作为 **agent tool** 调用时表现异常。三个症状看似无关，实为三层不同的问题：

| # | 症状 | 失败方式 | 根因位置 |
|---|---|---|---|
| 1 | 调用直接报错 | **报错**（会喊） | `lib/index.js` 返回值形状 |
| 2 | 反引号被插入空格 | **变形**（结果别扭） | `core/engine.cjs` 词法器 |
| 3 | 工具返回一片空白 | **沉默**（什么都不说） | `lib/index.js` render 契约 |

---

## Bug 1 · `value is not lossless JSON`（报错）

**症状**：任何输入都失败，包括最小样本 `select \`a\`.\`id\` from \`t\` \`a\``。

**定位**：在 DSH 的 `@deepseek-ai/dsh-tools/lib/index.js` 找到校验入口：

```js
function snapshotToolValue(toolName, candidate) {
  const detached = snapshotJsonValue(candidate);
  if (detached === void 0) throw new ToolOutputError(toolName, ["value is not lossless JSON"]);
```

**根因**：`engine.process()` 在 `format` 模式下**只返回** `formatted / diagnostics / macros / tokens`，并不返回 `formatSafe / diff / sql / applied / stable`（那几个只有 `fix` 模式才产出）。而 `lib/index.js` 的 `processSql()` 无条件平铺了全部 8 个字段：

```js
return { formatted, formatSafe: result.formatSafe, ..., diff: result.diff, sql: result.sql, ... }
```

于是 5 个键的值是 `undefined`。**`JSON.stringify` 遇到 `undefined` 会静默丢弃该键**，校验方一比对发现键少了，判定"有损"，整个调用失败。

**为什么长期没暴露**：HTTP 端点走的是 `JSON.stringify(result)` 直发，丢键无所谓，**面板照常能用**。只有 agent tool 那条严格校验的路径会炸。这个 bug 一直藏在"能用"的假象里。

**修复**：`dropUndef()` 过滤掉值为 `undefined` 的键再返回。

---

## Bug 2 · 反引号被拆（变形）

**症状**：输入 `` `a`.`project_number` ``，输出成 `` ` a`.` project_number` `` —— 每个开引号后多一个空格。SQL 依然合法（反引号内允许空白），但看着就是不对。

**定位**：把症状逐字符对照 token 流，发现根因在词法器：

- `core/engine.cjs` 没有反引号规则，`` ` `` 落进最后那条兜底分支：
  ```js
  // 兜底:未知字符原样保留为 OP,绝不丢弃
  tokens.push(tok(T.OP, c0, l, c));
  ```
- 而格式化器有一条空格规则：
  ```js
  if (prev.type === T.KEYWORD || prev.type === T.COMMA || prev.type === T.OP) return true;
  ```
  **"前一个 token 是 OP 就补空格"** —— 于是 `` ` `` (OP) 和标识符 `a` (IDENT) 被强行拆开。

逐字符吻合，根因确认。

**修复**：词法器新增反引号扫描，`` `xxx` `` 整体识别为一个 `IDENT`。未闭合时保留字符并给一条诊断（绝不丢字符）。

---

## Bug 3 · 工具返回空白（沉默）

**症状**：不再报错，但工具结果显示成 `(no output)`。**没有任何错误信息。**

**定位**：读 DSH 的类型声明，发现契约：

```ts
// @deepseek-ai/dsh-tools/lib/types/index.d.ts
render(args: unknown, value: JsonValue): ContentBlock[]
```

**必须返回内容块数组**。而本插件返回的是一段字符串：

```js
render: (args, value) => { ...; return parts.join('\n') }
```

再对照 DSH 内置工具的写法，确认形状：

```js
return [{ type: "text", text: parts.join("\n") }]
```

**为什么是沉默的**：`render` 的返回值走 `snapshotProjection()`，它**只校验"是不是合法 JSON"**。字符串当然是合法 JSON → 放行 → 内容被存在那里 → 但消费端要的是内容块数组，拿不到块，于是什么都不显示。**不抛错、不告警、不提示。**

**修复**：`render` 返回 `[{ type: 'text', text: ... }]`，并给空结果加了兜底文案。

---

## 附一 · 合并引擎死副本

排查中发现同目录存在两份引擎：

```
core/engine.cjs   ← lib/index.js 实际 require 的（运行时）
core/engine.js    ← README / RENDER-SPEC / test.js 指向的（文档与测试）
```

两者已经分叉约 53 行 —— **修 bug 一直只修 `.cjs`**，而文档指向的是旧的 `.js`。而 `test.js` 的 `require('./engine')` 在 CJS 解析下命中的正是 `.js`，等于测试测的是旧引擎。（它其实还跑不起来：包声明了 `type: module`，CJS 脚本 `require` 未定义。）

处理：删除 `engine.js`，引擎回到单一正本 `engine.cjs`；`test.js` / `fmt-sample.js` 改名 `.cjs` 并修正 require 路径，回归测试恢复可用。

---

## 附二 · 格式化器排版升级

同批完成的排版能力（均带**宽度闸门**，阈值 `INLINE_MAX = 72` 字符，短查询不受影响）：

| 能力 | 说明 |
|---|---|
| SELECT 列表一列一行 | 顶层列表够宽才展开 |
| CASE 展开 | `WHEN / ELSE / END` 各起一行 |
| 括号不堆阶梯 | 缩进只统计**含子查询**的括号；ORM 生成的 `(((((` 纯分组括号不再逐层累加（实测最大缩进 32 → 8 列） |
| 连续闭合括号合并 | `)))))` 并到一行，而不是 5 行孤零零的 `)` |

**过程中的一次翻车值得记**：我一度给 JOIN 关键字加了"多缩一级"，结果打挂了需求稿 §4.1 的黄金用例 —— 那条用例明确规定 **`LEFT JOIN` 与 `FROM` 同级**。黄金用例就是规格本身，不该为了"我觉得更好看"去改它。已撤回。

---

## 三条可迁移的经验

1. **契约不符但不抛错的接口最贵。** 前两个 bug 都会留痕迹（报错 / 结果别扭），第三个什么都不留。当一个接口"能接受任何东西"时，错误就被推到了很远的下游，甚至推没了。

2. **同一份逻辑有两条出口时，按最严的那条校验。** 这里的 HTTP 端点（`JSON.stringify` 直发）宽容，agent tool 路径（无损校验）严格 —— 宽容那条掩盖了严格那条的 bug 很久。

3. **看到"文档指向的实现"和"运行时加载的实现"不是同一份文件时，立刻停下来。** 这几乎总意味着有人在错误的地方改代码。
