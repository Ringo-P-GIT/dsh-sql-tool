# dsh-sql-tool 渲染规范（RENDER-SPEC）

> 版本 v1.0 · 2026-09-12 · 适用范围：`sql_tool` 输出的一切可视化（对话内 VCP 卡片、未来的侧栏面板、复制/导出产物）
> 引擎（`core/engine.cjs`）**只产出纯文本 + token 类型，不含任何颜色**。颜色是渲染层的映射结果——所以改配色与改引擎解耦，本文件是唯一配色权威。

---

## 1. 铁律：颜色不改文本

渲染产物**去掉全部标签后，必须与引擎原文逐字相同**（空格、换行、单引号、宏体一字不动）。

原因：`replace` 模式依赖「按宏文本精确匹配」做批量替换；一旦高亮层吞掉或规范化了任何字符，替换就对不上。

**验收校验**（每次改渲染层都跑）：

```js
stripTags(painted) === result.formatted   // 必须为 true
```

顺带一条：颜色只跟 **token 类型** 走，与「展开模式 / Compact 模式」无关——同一段 SQL 在两种模式下配色规则完全一致。

---

## 2. 色板

| 用途 | CSS 变量 | Hex | 说明 |
|---|---|---|---|
| 代码块底 | `--code-bg` | `#0b0f14` | 比卡面更深一档，让文字浮起 |
| 卡面 | `--panel` | `#161b22` | |
| 描边 | `--line` | `#30363d` | 唯一分割手段，不用阴影堆层级 |
| 默认文本 | `--fg` | `#a5b3c0` | 对底对比度 ≈ 8.7:1 |
| 关键字 | `--kw` | `#3fb950` | SELECT/FROM/WHERE/JOIN… |
| 宏名 + 括号 | `--mac` | `#d29922` | 见 §3 |
| **@form 专色** | `--form` | `#f0883e` | 见 §3.2，独立于 `--mac` |
| 字符串 | `--str` | `#79c0ff` | 引号与纯文本体 |
| 诊断 error | `--err` | `#f85149` | |
| 诊断 warn | `--warn` | `#d29922` | 与 `--mac` 同色，语义一致 |
| 次要说明 | `--dim` | `#8b949e` | 行号、提示、折叠标签 |

配色纪律：代码区是**语义色板**（每色都答得出「它代表什么」），卡面其余部分仍守「全卡 ≤5 色 + 强调色至多一处」。深底三要求照旧：正文对比度 ≥4.5:1、全卡至多 1 张暗卡、光效 ≤2 处。

---

## 3. 宏着色规则（核心）

### 3.1 一般宏：宏名 + 括号琥珀，宏体照常上色

`@nullValue` / `@sqlvalue` / `@Sqlvalue` / `@sqlset` / `@getDeptCode` / `@processId` / `@avg` 等一律：

- `@` + 宏名 + `(` → `--mac`（琥珀，`font-weight:600`）
- 闭合 `)` → `--mac`
- **宏体按内部 token 各自类型上色**：关键字绿、字符串蓝、标识符默认灰

```
@sqlvalue(                              ← 琥珀
    SELECT DISTINCT a.company           ← SELECT 绿 / 其余灰
    FROM BO_EU_FIN_DIVISION a           ← FROM 绿
    WHERE a.company = '…'               ← WHERE 绿 / 字符串蓝
)                                       ← 琥珀
```

> **为什么不做成整块一色**：`@Sqlvalue(SELECT b.code FROM … WHERE …)` 这类叶子宏体长，整块上色会把内部 SQL 糊成一团，读者失去「这是查询」的结构感。

### 3.2 `@form(...)`：整块独立橙色

`@form(BO_EU_CONTRACT_FULFILLMENT,PROJECTID)` **整体一个 `--form` 橙色 span，不拆段、不下沉**（判据：`token.name.toLowerCase() === '@form'`）。

理由：

1. 它是**纯参数宏**——体里只有表名 / 字段名，没有 SQL 语法，下沉也分不出结构；
2. 整块橙色让读者一眼认出「**这是一个绑定占位，不是真实值**」，与周围的表名、字段名形成视觉隔离，不会被误读成 SQL 标识符；
3. 它是需求稿里出现频率最高的宏，值得一个专属色。

> 注：`@form` 的专色**不影响**其他宏；`--form` 只服务这一个宏，不做泛化。若将来出现同类「纯参数绑定宏」，在 §6 登记后共享该色。

### 3.3 `@` 开头的非法引用

`ATBAD`（`@name` 后面没有 `(`）→ `--err` 红色。渲染层的红色与引擎诊断（`rule: 'atfunc'`）形成颜色呼应。

---

## 4. token 类型映射表

引擎词法常量 `T`（`core/engine.cjs` 第 67 行起）：

| token 类型 | 含义 | 颜色 |
|---|---|---|
| `keyword` | SQL 关键字 | `--kw` |
| `macro` | `@xxx(...)` 宏 | §3 规则 |
| `string` | 单引号字符串 | `--str`（引号 + 纯文本体） |
| `comment` | 注释 | `--dim` 斜体 |
| `atbad` | 残缺 `@` 引用 | `--err` |
| `ident` / `number` | 标识符、数字 | `--fg`（**不着重色**，避免颜色通胀） |
| `paren` / `comma` / `op` / `dot` | 标点运算符 | `--fg` |
| `ws` / `nl` | 空白 / 换行 | 原样输出 |

**不着色 `ident` / `number`** 是刻意选择：SQL 里标识符占比最高，一旦上色整屏花掉，关键字与宏就失去了对比。

---

## 5. 嵌套结构与下沉取值

引擎的 MACRO token 自带完整内部结构，**渲染层直接用，无需重新解析、无需改引擎**：

```
MACRO token
├─ text     原文切片（一个字不差，保底用）
├─ name     宏名（不含 @）
├─ parts[]  参数列表
│   ├─ lead  逗号后的空白
│   └─ toks[] 该参数的 token 数组（含嵌套 MACRO）
├─ endLine / endCol
└─ （未闭合时另有诊断，token 仍在）
```

STRING token 同理带 `segs[]`，元素为 `{kind:'macro', token}` 或 `{kind:'text', text}`——**字符串里的宏**（如 `'@form(...)'`）通过它取到，颜色照 §3.2 打。

### 参考实现

```js
function paintTok(t) {
  switch (t.type) {
    case 'keyword': return span('kw', esc(t.text))
    case 'macro':   return paintMacro(t)
    case 'string':  return paintString(t)
    case 'comment': return span('cm', esc(t.text))
    case 'atbad':   return span('err', esc(t.text))
    case 'ws': case 'nl': return t.text
    default:        return esc(t.text)
  }
}
function paintMacro(t) {
  if (String(t.name).toLowerCase() === 'form') return span('form', esc(t.text)) // 专色:整块
  let out = span('mac', esc('@' + t.name + '('))
  t.parts.forEach((p, i) => {
    if (i) out += ','
    if (p.lead) out += esc(p.lead)
    p.toks.forEach(x => { out += paintTok(x) })
  })
  return out + span('mac', ')')
}
function paintString(t) {
  if (!t.segs || !t.segs.length) return span('str', esc(t.text))
  let out = span('str', "'")
  t.segs.forEach(g => {
    out += g.kind === 'macro' ? paintMacro(g.token) : span('str', esc(g.text))
  })
  return out + span('str', "'")
}
```

> ⚠️ 实现后**必跑 §1 的去标签校验**。宏体经 `parts` 重建时最容易丢的就是逗号后的空格与 `@sqlset` 的分隔符空白——`@sqlset` 的分隔符参数（第二参数起）必须用**原文重建**（`',' + lead + toks.map(t=>t.text).join('')`），不得参与下沉排版；其余部分按形态走 §6。

---

## 6. 例外登记表

新增「整块单色」的宏必须登记在此，否则默认走 §3.1 下沉规则：

| 宏 | 处理 | 颜色 | 理由 |
|---|---|---|---|
| `@form` | 整块单色 | `--form` `#f0883e` | 纯参数绑定占位，需与标识符强区分 |
| `@sqlset`（**未展开**，原文单行） | 整块单色 | `--mac` `#d29922` | 短形式下体就是一条极短查询，下沉无收益且易吃分隔符空白 |
| `@sqlset`（**已展开**，体是语句级查询） | 名+括号 `--mac`，体走 §3.1 下沉 | 体按 SQL 上色 | 语句级包装宏：43 行查询整块涂琥珀会让全卡失色阶，与 `@form` 的小巧占位性质不同 |

> `@sqlset` 尾部**分隔符参数**（`, ` 的逗号、空白与其后的 `)`）一律原文着色：`)` 取 `--mac`，逗号与空白取默认色。展开与否由引擎 `needsExpand()` 判定，渲染层直接看该 token 是否已被排版成多行。

---

## 7. 诊断着色

引擎 `diagnostics[]` 元素结构：`{line, col, level, rule, message}`。

| rule | 含义 | 颜色 |
|---|---|---|
| `concatenation` | 缺空格粘连（`org_numberFROM`） | `--err` |
| `paren` | 括号 / 引号不闭合 | `--err` |
| `atfunc` | @ 函数参数、未注册、缺闭合 | `level==='error'` → `--err`；`level==='warn'` → `--warn` |
| `json` | JSON 语法错误 | `--err` |

呈现约定：

- 行号用 `--dim`，定位格式 `[line:col]`，列号指向**缺失空格之后 / 错误字符本身**（引擎已算好，勿二次推算）；
- 定位到源文本时用**下划线或背景块**标出，不要改变字色——避免与语法色打架；
- 诊断数为 0 时显示绿色成功态，不展示空列表。

---

## 8. 卡片骨架约定（VCP 交付）

对话内交付走裸 HTML 卡片（Client-plugin 审批受限，侧栏面板暂不可用），沿用既有技术铁律：

- 根容器 `<div id="vcp-root">`（**id 不是 class**）；样式选择器一律 `#vcp-root` 前缀；`<style>` 紧跟根开标签之后；根与 style 内**无空行**
- 根开标签只放短关键值（背景/字色/font-family/字号）；长样式进 `<style>`
- `font-family` 必须内联；标题用 `Lanxi-点黑` 等艺术体，代码用 `'Cascadia Code','JetBrains Mono',monospace`
- 不用 `backdrop-filter`；不写 `<script>`；交互仅 `onclick="input('...')"` 且**必须是纯字符串字面量**（渲染器正则只认这种形态，含 `+` / 三元 / `window.*` 会被整条丢弃）
- 禁 `flex-wrap:wrap` 与 `margin:0 auto`；入场只用 opacity 淡入
- CSS ≤ 约 200 行、类选择器 ≤ 12 个，用过的类必须定义
- 代码内尖括号必须转义（`&lt;` `&gt;`），否则被当标签解析

**唯一禁令**：深蓝黑底 + 荧光青发光字。本文档的深底代码块属【惊艳出口】合法场合，须守 §2 的三条对比度/光效约束。

---

## 9. VCP 输出大小策略

安全生产阈值(任一超出即降级):

| 指标 | 上限值 | 超过后 |
|---|---|---|
| 代码纯文本 | **≤ 5 KB**(约 50 行 SQL) | 纯文本 + 轻量 CSS |
| HTML span 标签 | **≤ 400 个** | 纯文本 + 轻量 CSS |

降级后仍保留:深底容器、统计栏、诊断摘要、`<details>` 可展开复制区(纯文本,`user-select:all`)。只是不按 token 加 `<span>` 着色——结构不丢、功能不缩。

判据统一由工具调用方在渲染前估算:格式化结果文本的 `length` ≤ 5000 且预估宏/关键字数量 × 2 ≤ 400 即走着色;否则走轻量。

---

## 10. 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.2 | 2026-09-17 | 新增 §9 VCP 输出大小策略(≤ 5 KB / ≤ 400 span 走着色,超出降级纯文本)。 |
| v1.1 | 2026-09-17 | `@sqlset` 分「未展开/已展开」两套规则：未展开整块琥珀、展开后名+括号琥珀体下沉 SQL 上色；分隔符参数原文重建。§6 登记表改两行。 |
| v1.0 | 2026-09-12 | 首版。确立「宏名+括号琥珀 / 宏体下沉上色 / `@form` 整块专色橙」三段规则，替代早期「整个宏 token 一色」的简化画法 |
