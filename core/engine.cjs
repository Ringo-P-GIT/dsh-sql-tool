'use strict';

/**
 * dsh-sql-core — 纯 JS SQL(@宏感知)引擎
 * =============================================
 * 单趟 lexer(上下文栈:普通/字符串/宏)→ token 流 → 四路消费:
 *   ① Formatter(展开模式/紧凑模式)  ② 校验器 ×3(粘连/括号/@格式)
 *   ③ 宏提取(去重+计数)            ④ 高亮 token(供 client 渲染)
 *
 * 无外部依赖,可在 Node 直接 require,也可内联进 Cordis host 插件。
 */

// 紧跟 `.` 或 `AS` 之后的词一定是标识符(字段名/别名),即使拼写撞上关键字也不得大写
// (需求稿 §4.1-4.2:表名/字段名一律保留原样,如 z.rows / AS rows)
function isIdentContext(prevSig) {
  if (!prevSig) return false;
  if (prevSig.type === T.DOT) return true;
  return prevSig.type === T.KEYWORD && prevSig.text.toUpperCase() === 'AS';
}

// 数组里最后一个非空白 token(判断 `AS` / `.` 上下文用)
function lastSig(arr) {
  for (let k = arr.length - 1; k >= 0; k--) {
    const t = arr[k];
    if (t.type !== T.WS && t.type !== T.NL) return t;
  }
  return null;
}

// ── SQL 关键字 ──────────────────────────────────────────────
const KEYWORDS = new Set([
  'SELECT','FROM','WHERE','AND','OR','NOT','IN','IS','NULL','LIKE','BETWEEN',
  'JOIN','LEFT','RIGHT','INNER','OUTER','FULL','CROSS','ON','AS',
  'GROUP','ORDER','BY','HAVING','LIMIT','UNION','ALL','DISTINCT',
  'INSERT','INTO','VALUES','UPDATE','SET','DELETE',
  'CASE','WHEN','THEN','ELSE','END','EXISTS',
  'ASC','DESC','OFFSET','FETCH','NEXT','ONLY',
  'OVER','PARTITION',
  'COALESCE','NVL','CAST','CONVERT','NULLIF','ISNULL',
  'TOP','WITH','RECURSIVE','TABLESAMPLE','PIVOT','UNPIVOT',
  'FOR','XML','PATH',
  'ANY','SOME','TRUE','FALSE',
  'PRIMARY','KEY','FOREIGN','REFERENCES','INDEX','UNIQUE','CHECK','DEFAULT',
  'CREATE','TABLE','VIEW','ALTER','DROP','ADD','COLUMN','CONSTRAINT',
  'IF','GRANT','REVOKE',
  'MATCHED','MERGE',
  'COMMIT','ROLLBACK','SAVEPOINT','TRANSACTION',
  'BEGIN','DECLARE','CURSOR','OPEN','CLOSE','DEALLOCATE',
  'PRINT','RAISERROR','THROW','TRY','CATCH',
  'EXEC','EXECUTE',
  'PROCEDURE','FUNCTION','TRIGGER','SCHEMA','DATABASE',
  'USE','GO','NOCOUNT','XACT_ABORT','ARITHABORT',
  'ROWCOUNT','IDENTITY',
  'GETDATE','SYSDATETIME','DATEADD','DATEDIFF','DATEPART','YEAR','MONTH','DAY',
]);

// 子句关键字(格式化时前置换行)
// 注:ON 不在其中 —— 需求稿 §4.1 目标里 `LEFT JOIN t f ON cond` 保持同一行
const CLAUSE_KW = new Set([
  'SELECT','FROM','WHERE','AND','OR',
  'JOIN','LEFT','RIGHT','INNER','OUTER','FULL','CROSS',
  'GROUP','ORDER','HAVING','LIMIT','UNION',
  'VALUES','SET','INSERT','UPDATE','DELETE',
]);

// ── token 类型 ──────────────────────────────────────────────
const T = {
  KEYWORD: 'keyword',
  IDENT: 'ident',
  NUMBER: 'number',
  STRING: 'string',
  MACRO: 'macro',
  PAREN: 'paren',
  COMMA: 'comma',
  OP: 'op',
  DOT: 'dot',
  COMMENT: 'comment',
  ATBAD: 'atbad',
  WS: 'ws',
  NL: 'nl',
};

const DEFAULT_FUNCS = [
  { name: '@form',        params: 2,      note: '取表单字段值(表名,字段名)' },
  { name: '@sqlvalue',    params: '1..2', note: '执行查询;空则走兜底' },
  { name: '@nullValue',   params: '1..2', note: 'NVL 语义(值,默认值)' },
  { name: '@getDeptCode', params: 2,      note: '1=一级部门号,2=二级部门号' },
  { name: '@sqlset',      params: '1..2', note: '设集合/变量;第二参数为值分隔符,紧跟逗号无空格' },
  { name: '@processId',   params: 0,      note: '当前流程实例 ID' },
  { name: '@avg',         params: '2..n', note: '求平均(至少2参数)' },
];

function buildFuncMap(list) {
  const m = new Map();
  for (const f of (list || [])) {
    if (f && f.name) m.set(String(f.name).toLowerCase(), f.params);
  }
  return m;
}

function tok(type, text, line, col) {
  return { type, text, line, col };
}

const isWordChar = c => /[a-zA-Z0-9_]/.test(c);

// ════════════════════════════════════════════════════════════
// Lexer
// ════════════════════════════════════════════════════════════
function lex(text) {
  const src = String(text == null ? '' : text);
  const tokens = [];
  const allMacros = [];
  const diagnostics = [];

  let i = 0, line = 1, col = 1;
  const len = src.length;

  function advance(n) {
    for (let k = 0; k < n && i < len; k++) {
      if (src[i] === '\n') { line++; col = 1; } else { col++; }
      i++;
    }
  }
  const ch = () => (i < len ? src[i] : '');
  const peek = o => (i + o < len ? src[i + o] : '');
  const done = () => i >= len;

  // 收集满足条件的连续字符
  function gather(pred) {
    const start = i;
    while (!done() && pred(src[i])) advance(1);
    return src.slice(start, i);
  }
  function skipInlineWs() {
    while (!done() && (ch() === ' ' || ch() === '\t')) advance(1);
  }

  // ── 扫描字符串:i 指向开引号,返回 STRING token(segs 含内部宏) ──
  function scanString() {
    const sl = line, sc = col;
    const segs = [];
    advance(1); // 跳过开引号
    let closed = false;
    while (!done()) {
      if (ch() === '\'') { advance(1); closed = true; break; }
      if (ch() === '@' && /[a-zA-Z]/.test(peek(1))) {
        const sub = scanMacro();
        segs.push({ kind: 'macro', token: sub });
        if (sub.type === T.MACRO) allMacros.push(sub);
        continue;
      }
      const tl = line, tc = col;
      const raw = gather(c0 => c0 !== '\'' && !(c0 === '@' && /[a-zA-Z]/.test(peek(1))));
      if (raw) segs.push({ kind: 'text', text: raw, line: tl, col: tc });
    }
    if (!closed) {
      diagnostics.push({
        line: sl, col: sc, level: 'error', rule: 'paren',
        message: '字符串缺少闭合的单引号 \'',
        fix: '在行尾补一个闭合的单引号 \'',
        fixAt: i,   // 字符串扫描停止处 = 插入 ' 的绝对位置
        fixWhat: "'",  // autoFix 用
      });
    }
    const st = tok(T.STRING, src.slice(offsetOf(sl, sc), i), sl, sc);
    st.segs = segs;
    return st;
  }

  // ── 扫描宏:i 指向 '@' ────────────────────────────────────
  function scanMacro() {
    const l = line, c = col;
    advance(1); // '@'
    const name = gather(c0 => isWordChar(c0));

    const saveI = i, saveLine = line, saveCol = col;
    skipInlineWs();
    if (ch() !== '(') {
      i = saveI; line = saveLine; col = saveCol;
      return tok(T.ATBAD, '@' + name, l, c);
    }
    advance(1); // '('

    // 参数:数组,每个 { toks:[], lead:'' }
    const parts = [];
    let cur = [];
    let curLead = '';        // 本参数的前导空白(分隔符语义,如 @sqlset 第二参数)
    let pendingLead = '';    // 逗号后累积的空白
    let depth = 1;
    let lastWasComma = false;
    const parenStack = [];   // 未闭合的 ( 位置:诊断时点名具体在哪一行
    // 宏自身的 '(' 也算一个未闭合位置(记录行号用于诊断)
    parenStack.push({ line: l, col: c + name.length + 1 });

    function closePart() {
      // pendingLead = 逗号后、参数前的空白。@sqlset 第二参数(值分隔符)可能整段就是空白
      // (@sqlset(sql, ) 分隔符=空格),丢了会少算参数个数、并破坏分隔符语义
      if (cur.length > 0 || curLead !== '' || pendingLead !== '') {
        parts.push({ toks: cur, lead: curLead !== '' ? curLead : pendingLead });
      } else if (lastWasComma) parts.push({ toks: [], lead: '' });
      cur = [];
      curLead = '';
      pendingLead = '';
    }

    function pushTok(t) {
      if (cur.length === 0 && pendingLead !== '') { curLead = pendingLead; pendingLead = ''; }
      cur.push(t);
    }

    while (!done() && depth > 0) {
      const c0 = ch();

      if (c0 === '\'') { pushTok(scanString()); continue; }

      if (c0 === '(') {
        pushTok(tok(T.PAREN, '(', line, col));
        parenStack.push({ line, col });
        advance(1); depth++; lastWasComma = false;
        continue;
      }
      if (c0 === ')') {
        depth--;
        parenStack.pop();
        if (depth === 0) {
          advance(1);
          // 不重置 lastWasComma:尾部空参数(如 @sqlset(sql,) 的分隔符)要靠它让 closePart 补位,
          // 重置会让 `,` 被整个丢掉(改坏语义)
        } else {
          pushTok(tok(T.PAREN, ')', line, col));
          advance(1);
          lastWasComma = false;
        }
        continue;
      }
      if (c0 === ',') {
        if (depth === 1) {
          closePart();
          lastWasComma = true;
          advance(1);
          // 逗号后空白 → 下一参数的 lead(分隔符敏感)
          const wsStart = i;
          while (!done() && (ch() === ' ' || ch() === '\t')) advance(1);
          pendingLead = src.slice(wsStart, i);
        } else {
          pushTok(tok(T.COMMA, ',', line, col));
          advance(1);
        }
        continue;
      }
      if (c0 === '@' && /[a-zA-Z]/.test(peek(1))) {
        const sub = scanMacro();
        pushTok(sub);
        if (sub.type === T.MACRO) allMacros.push(sub);
        lastWasComma = false;
        continue;
      }
      // 空白 → 保留 WS/NL token(格式化间距需要)
      if (c0 === ' ' || c0 === '\t') {
        const wl = line, wc = col;
        const ws = gather(c0 => c0 === ' ' || c0 === '\t');
        pushTok(tok(T.WS, ws, wl, wc));
        lastWasComma = false;
        continue;
      }
      if (c0 === '\n' || c0 === '\r') {
        const wl = line, wc = col;
        const nl = gather(c0 => c0 === '\n' || c0 === '\r');
        pushTok(tok(T.NL, nl, wl, wc));
        lastWasComma = false;
        continue;
      }
      if (/[a-zA-Z_$]/.test(c0)) {
        const wl = line, wc = col;
        const word = gather(c0 => isWordChar(c0));
        const uc = word.toUpperCase();
        const asIdent = isIdentContext(lastSig(cur));
        pushTok(!asIdent && KEYWORDS.has(uc) ? tok(T.KEYWORD, word, wl, wc) : tok(T.IDENT, word, wl, wc));
        lastWasComma = false;
        continue;
      }
      if (/\d/.test(c0)) {
        const wl = line, wc = col;
        const num = gather(c0 => /[0-9.]/.test(c0));
        pushTok(tok(T.NUMBER, num, wl, wc));
        lastWasComma = false;
        continue;
      }
      if (c0 === ':' && peek(1) === '=') {
        const wl = line, wc = col;
        pushTok(tok(T.OP, ':=', wl, wc));
        advance(2); lastWasComma = false;
        continue;
      }
      if (/[=<>!|&+\-*\/%]/.test(c0)) {
        const wl = line, wc = col;
        let op = c0; advance(1);
        const nx = ch();
        if ((op === '>' || op === '<' || op === '!' || op === '=') && nx === '=') { op += '='; advance(1); }
        else if (op === '<' && nx === '>') { op += '>'; advance(1); }
        else if ((op === '|' || op === '&') && nx === op) { op += nx; advance(1); }
        pushTok(tok(T.OP, op, wl, wc));
        lastWasComma = false;
        continue;
      }
      if (c0 === '.') {
        pushTok(tok(T.DOT, '.', line, col)); advance(1); lastWasComma = false;
        continue;
      }
      // 兜底:未知字符原样保留为 OP,绝不丢弃(丢字符 = 改坏 SQL)
      pushTok(tok(T.OP, c0, line, col));
      advance(1);
      lastWasComma = false;
    }

    if (depth > 0) {
      const unclosed = parenStack[parenStack.length - 1] || { line: l, col: c };
      const need = depth;
      // 缺 ) 的落点取决于断句意图(常该落在字符串内,如 ',ELSE' 应为 ',ELSE)' ),
      // 回扫无法可靠判定 → 只报缺几个,不宣称位置,也不自动落笔
      diagnostics.push({
        line: unclosed.line, col: unclosed.col, level: 'error', rule: 'atfunc',
        message: `@${name}( 缺少闭合的 ),始于此 ( 行 ${unclosed.line} 列 ${unclosed.col}`,
        fix: `补 ${need} 个闭合括号 )`,
        fixAt: i,
        fixWhat: ')',
      });
    }
    closePart();

    const rawText = src.slice(offsetOf(l, c), i);
    const macroTok = tok(T.MACRO, rawText, l, c);
    macroTok.name = name;
    macroTok.parts = parts;
    macroTok.endLine = line;
    macroTok.endCol = col;
    return macroTok;
  }

  // 由行列反查字符偏移(用于宏原文切片)
  let lineStarts = null;
  function offsetOf(l, c) {
    if (!lineStarts) {
      lineStarts = [0];
      for (let k = 0; k < len; k++) if (src[k] === '\n') lineStarts.push(k + 1);
    }
    return (lineStarts[l - 1] || 0) + (c - 1);
  }

  // ── 主循环 ────────────────────────────────────────────────
  while (!done()) {
    const c0 = ch();
    const l = line, c = col;

    if (c0 === ' ' || c0 === '\t') {
      const ws = gather(c0 => c0 === ' ' || c0 === '\t');
      tokens.push(tok(T.WS, ws, l, c));
      continue;
    }
    if (c0 === '\n' || c0 === '\r') {
      const nl = gather(c0 => c0 === '\n' || c0 === '\r');
      tokens.push(tok(T.NL, nl, l, c));
      continue;
    }
    if (c0 === '-' && peek(1) === '-') {
      const cmt = gather(c0 => c0 !== '\n');
      tokens.push(tok(T.COMMENT, cmt, l, c));
      continue;
    }
    if (c0 === '/' && peek(1) === '*') {
      let cmt = ''; const cl = l, cc = c;
      advance(2); cmt = '/*';
      while (!done()) {
        if (ch() === '*' && peek(1) === '/') { cmt += '*/'; advance(2); break; }
        cmt += ch(); advance(1);
      }
      tokens.push(tok(T.COMMENT, cmt, cl, cc));
      continue;
    }

    // ── 字符串(内部可嵌宏) ──
    if (c0 === '\'') {
      tokens.push(scanString());
      continue;
    }

    // ── 宏 ──
    if (c0 === '@' && /[a-zA-Z]/.test(peek(1))) {
      const m = scanMacro();
      if (m.type === T.MACRO) allMacros.push(m);
      tokens.push(m);
      continue;
    }
    if (c0 === '@') {
      tokens.push(tok(T.ATBAD, '@', l, c));
      advance(1);
      continue;
    }

    if (c0 === '(' || c0 === ')') { tokens.push(tok(T.PAREN, c0, l, c)); advance(1); continue; }
    if (c0 === ',') { tokens.push(tok(T.COMMA, ',', l, c)); advance(1); continue; }
    if (c0 === '.') { tokens.push(tok(T.DOT, '.', l, c)); advance(1); continue; }
    if (c0 === ':' && peek(1) === '=') { tokens.push(tok(T.OP, ':=', l, c)); advance(2); continue; }
    if (/[=<>!|&+\-*\/%]/.test(c0)) {
      let op = c0; advance(1);
      const nx = ch();
      if ((op === '>' || op === '<' || op === '!' || op === '=') && nx === '=') { op += '='; advance(1); }
      else if (op === '<' && nx === '>') { op += '>'; advance(1); }
      else if ((op === '|' || op === '&') && nx === op) { op += nx; advance(1); }
      tokens.push(tok(T.OP, op, l, c));
      continue;
    }
    if (/\d/.test(c0)) {
      const num = gather(c0 => /[0-9.]/.test(c0));
      tokens.push(tok(T.NUMBER, num, l, c));
      continue;
    }
    if (/[a-zA-Z_$]/.test(c0)) {
      const word = gather(c0 => isWordChar(c0));
      const uc = word.toUpperCase();
      const asIdent = isIdentContext(lastSig(tokens));
      tokens.push(!asIdent && KEYWORDS.has(uc) ? tok(T.KEYWORD, word, l, c) : tok(T.IDENT, word, l, c));
      continue;
    }
    // 兜底:未知字符原样保留为 OP,绝不丢弃
    tokens.push(tok(T.OP, c0, l, c));
    advance(1);
  }

  runConcatenationCheck(tokens, diagnostics);
  return { tokens, macros: allMacros, diagnostics };
}

// ════════════════════════════════════════════════════════════
// 校验器
// ════════════════════════════════════════════════════════════

// ① 粘连:标识符内"前缀标识符 + 后缀关键字"
//    只认长度 ≥4 的高信号子句关键字(FROM/WHERE/JOIN/SELECT…),
//    避免 division→ON、dataset→SET、domain→IN 这类误报
const CONCAT_SUFFIX_MIN = 4;
// 粘连校验只认「块级子句词」作后缀,避免 APPROVER→APPR OVER 这类单词误报
const CONCAT_SUFFIX_KW = new Set([
  'SELECT','FROM','WHERE','JOIN','GROUP','ORDER','HAVING','UNION','LIMIT',
  'VALUES','INSERT','UPDATE','DELETE','INTO',
]);

function runConcatenationCheck(tokens, diagnostics) {
  for (const t of tokens) {
    if (t.type !== T.IDENT) continue;
    const w = t.text;
    if (w.length < CONCAT_SUFFIX_MIN + 1 || w.includes('.')) continue;
    for (let k = 1; k <= w.length - CONCAT_SUFFIX_MIN; k++) {
      const prefix = w.slice(0, k);
      const suffix = w.slice(k);
      if (!/^[a-zA-Z_$]/.test(prefix)) continue;
      if (KEYWORDS.has(prefix.toUpperCase())) continue;   // leftjoin / order_no 这类不报
      const su = suffix.toUpperCase();
      if (su.length >= CONCAT_SUFFIX_MIN && CONCAT_SUFFIX_KW.has(su)) {
        diagnostics.push({
          line: t.line, col: t.col + k, level: 'error', rule: 'concatenation',
          message: `疑似缺空格:"${w}" → "${prefix} ${suffix}",建议补空格`,
        });
        break;
      }
    }
  }
}

// ② 括号配对
function validateParen(tokens, diagnostics) {
  const stack = [];
  for (const t of tokens) {
    if (t.type !== T.PAREN) continue;
    if (t.text === '(') stack.push(t);
    else if (t.text === ')') {
      if (stack.length === 0) {
        diagnostics.push({
          line: t.line, col: t.col, level: 'error', rule: 'paren',
          message: '多余的右括号 )',
        });
      } else stack.pop();
    }
  }
  for (const s of stack) {
    diagnostics.push({
      line: s.line, col: s.col, level: 'error', rule: 'paren',
      message: '括号不配对:左括号缺少对应的 )',
    });
  }
}

// ③ @ 函数格式
function validateAtFunc(macros, funcMap, diagnostics) {
  for (const m of macros) {
    const key = '@' + String(m.name).toLowerCase();
    const spec = funcMap ? funcMap.get(key) : undefined;
    const pc = m.parts ? m.parts.length : 0;
    if (spec === undefined) {
      if (funcMap) {
        diagnostics.push({
          line: m.line, col: m.col, level: 'warn', rule: 'atfunc',
          message: `未注册的 @ 函数: @${m.name}`,
        });
      }
      continue;
    }
    let ok = true;
    if (typeof spec === 'number') ok = (pc === spec);
    else if (typeof spec === 'string' && spec.includes('..')) {
      const [a, b] = spec.split('..');
      const min = parseInt(a, 10);
      const max = (b === 'n' || b === 'N') ? Infinity : parseInt(b, 10);
      ok = !(pc < min || pc > max);
    }
    if (!ok) {
      diagnostics.push({
        line: m.line, col: m.col, level: 'error', rule: 'atfunc',
        message: `函数 @${m.name} 参数个数异常:期望 ${spec},实际 ${pc}`,
      });
    }
  }
}

// ④ ATBAD(缺左括号)
//    MySQL 会话变量 @i / @f 形如 @单字符 或紧跟 := 赋值,不是残缺宏 → 不告警(误报比漏报更糟)
function isSessionVar(t, text, funcMap) {
  const name = t.text.slice(1);
  if (funcMap && funcMap.has('@' + name.toLowerCase())) return false;
  const start = t.col - 1 + t.text.length;
  const nextCh = text.charAt(start);
  return name.length === 1 || nextCh === ':';
}

// 行/列 → 绝对字符偏移(autoFix 插入位置用)
function posToOffset(text, line, col) {
  let off = 0;
  let ln = 1;
  while (off < text.length && ln < line) {
    if (text[off] === '\n') ln++;
    off++;
  }
  return off + (col - 1);
}

// 递归收集所有 ATBAD:顶层 + 字符串 segs 内嵌宏 + 宏体 parts 内嵌 token
// 缺左括号的残缺宏大多藏在字符串里(如 '@getDeptCode@form(...)' ),只看顶层会漏
function collectAtbads(tokens, out) {
  for (const t of tokens || []) {
    if (!t || typeof t !== 'object') continue;
    if (t.type === T.ATBAD) { out.push(t); continue; }
    if (t.type === T.MACRO && Array.isArray(t.parts)) {
      for (const p of t.parts) {
        if (p && Array.isArray(p.toks)) collectAtbads(p.toks, out);
      }
    } else if (t.type === T.STRING && Array.isArray(t.segs)) {
      for (const g of t.segs) {
        if (g && g.kind === 'macro' && g.token) collectAtbads([g.token], out);
      }
    }
  }
}

function validateAtBad(tokens, src, diagnostics, funcMap) {
  const text = String(src == null ? '' : src);
  const all = [];
  collectAtbads(tokens, all);
  for (const t of all) {
    if (t.type !== T.ATBAD) continue;
    if (isSessionVar(t, text, funcMap)) continue;
    const start = t.col - 1 + t.text.length;
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    const rest = text.slice(start, end);
    const atname = t.text;   // '@formBO_EU_CONTRACT_PURCHASE'
    const lower = atname.toLowerCase();
    const off = posToOffset(text, t.line, t.col);
    // 智能修复:精确匹配 → 直接补 ( ; 否则查最长注册函数前缀
    let fixMsg, fixAt, fixWhat;
    if (funcMap && funcMap.has(lower)) {
      // 精确命中: @form → @form(
      fixMsg = `在 '${atname}' 后、第 ${t.col + t.text.length} 列插入 (`;
      fixAt = off + atname.length;
      fixWhat = '(';
    } else if (funcMap) {
      // 模糊前缀: @formBO_EU_... → @form(BO_EU_...
      let best = null;
      for (const k of funcMap.keys()) {
        if (k.length >= 2 && lower.startsWith(k) && lower.length > k.length) {
          if (!best || k.length > best.length) best = k;
        }
      }
      if (best) {
        const remainder = atname.slice(best.length); // 'BO_EU_CONTRACT_PURCHASE'
        fixMsg = `在 '${best}' 后插入 (,修正为 '${best}(${remainder}'`;
        fixAt = off + best.length;
        fixWhat = '(';
      }
    }
    // 无函数清单时的兜底:至少在宏名后补个 ( (位置仍然精确)
    if (typeof fixAt !== 'number') {
      fixMsg = `在 '${atname}' 后、第 ${t.col + t.text.length} 列插入 (`;
      fixAt = off + atname.length;
      fixWhat = '(';
    }
    if (rest.includes(')')) {
      diagnostics.push({
        line: t.line, col: t.col, level: 'error', rule: 'atfunc',
        message: `疑似想写 ${t.text}(…),缺少左括号 (`,
        fix: fixMsg || `在 '${t.text}' 后、第 ${t.col + t.text.length} 列插入 (`,
        ...(typeof fixAt === 'number' ? { fixAt, fixWhat } : {}),   // 插入位置与内容(autoFix 用)
      });
    } else {
      diagnostics.push({
        line: t.line, col: t.col, level: 'warn', rule: 'atfunc',
        message: `孤立的 @ 引用 "${t.text}",缺少调用括号`,
        fix: `在 '${t.text}' 后补充调用括号 ()`,
      });
    }
  }
}

// ════════════════════════════════════════════════════════════
// 宏提取(去重 + 计数)
// ════════════════════════════════════════════════════════════
function extractMacros(macros) {
  const map = new Map();
  for (const m of macros) {
    const key = m.text;
    const hit = map.get(key);
    if (hit) hit.count++;
    else map.set(key, {
      text: m.text,
      name: '@' + m.name,
      params: m.parts ? m.parts.length : 0,
      count: 1,
    });
  }
  return Array.from(map.values());
}

// ════════════════════════════════════════════════════════════
// Formatter
// ════════════════════════════════════════════════════════════
const IND = 4;
// 括号块"单行宽度"阈值:超过才允许拆子句。短子查询如 (SELECT @i := 0) 保持一行,
// 不为了形式统一把几个 token 拆成三行
const INLINE_MAX = 72;
// 与后续关键字紧联的子句词(LEFT JOIN / GROUP BY / UNION ALL 不拆行)
const BINDER_KW = new Set(['GROUP','ORDER','LEFT','RIGHT','INNER','OUTER','FULL','CROSS','UNION','PARTITION']);
// 函数名:与左括号紧贴(coalesce( / max( ),子句词后保留空格(FROM ( / IN ( / VALUES ( )
const SQL_FUNCS = new Set([
  'COALESCE','NVL','NVL2','IFNULL','NULLIF','DECODE','CAST','CONVERT','GREATEST','LEAST',
  'COUNT','SUM','AVG','MIN','MAX','ROUND','TRUNC','CEIL','FLOOR','ABS','MOD','POWER',
  'SUBSTR','SUBSTRING','LENGTH','CHAR_LENGTH','TRIM','LTRIM','RTRIM','UPPER','LOWER',
  'REPLACE','INSTR','CONCAT','CONCAT_WS','LPAD','RPAD','FORMAT',
  'TO_CHAR','TO_DATE','TO_NUMBER','DATE_FORMAT','STR_TO_DATE','DATEDIFF','TIMESTAMPDIFF',
  'IF','ISNULL','ROW_NUMBER','RANK','DENSE_RANK','LISTAGG','WM_CONCAT','XMLAGG','GROUP_CONCAT',
  'EXISTS','NOT_EXISTS','JSON_EXTRACT','JSON_VALUE',
]);

function format(tokens, options) {
  const compact = !!(options && options.compact);

  // 估算 k 处 '(' 起、到配对 ')' 的括号块单行宽度(用于判断值不值得拆行)
  function parenInlineWidth(toks, k) {
    let depth = 0, w = 0;
    for (let x = k; x < toks.length; x++) {
      const t = toks[x];
      if (t.type === T.PAREN) {
        if (t.text === '(') depth++;
        else { depth--; if (depth === 0) { w += 1; break; } }
      }
      if (t.type === T.WS || t.type === T.NL) { w += 1; continue; }
      w += (t.text ? t.text.length : 0) + 1;
    }
    return w;
  }

  // 返回 lines[](行内已含绝对缩进;首行不含缩进前缀)
  function fmtToks(toks, baseIndent) {
    const lines = [''];
    let curIndent = baseIndent;
    let pendingSpace = false;
    let prev = null;
    const parenStack = [];   // 括号层级栈:{broken} 该层内是否已经换行(决定 ) 是否独占一行)

    const cur = () => lines[lines.length - 1];
    const setCur = v => { lines[lines.length - 1] = v; };
    const flush = () => { if (cur().trim() !== '') lines.push(''); };
    const newLine = ind => {
      flush();
      curIndent = ind;
      setCur(' '.repeat(ind));
      pendingSpace = false;
      prev = null;
      if (parenStack.length) parenStack[parenStack.length - 1].broken = true;
    };
    const add = s => setCur(cur() + s);
    // 子句换行的基准缩进:每深入一层括号多一级
    const clauseIndent = () => baseIndent + parenStack.length * IND;

    // 当前 token 前是否需要空格
    function spaceBefore(t) {
      if (!prev) return false;
      if (t.type === T.COMMA || t.type === T.DOT) return false;
      if (t.type === T.PAREN) {
        if (t.text !== '(') return false;
        // 函数名与左括号紧贴:coalesce( / max( ;子句词后保留空格:FROM ( / IN (
        if (prev.type === T.KEYWORD) return !SQL_FUNCS.has(prev.text.toUpperCase());
        // 比较运算符后接子查询: = ( / >= (
        if (prev.type === T.OP) return true;
        // 逗号后接子查询: , (
        if (prev.type === T.COMMA) return true;
        return pendingSpace;
      }
      // 闭合右括号后接别名/词: ) f / ) z(避免 )f 这种粘连)
      if (prev.type === T.PAREN && prev.text === ')' &&
          (t.type === T.IDENT || t.type === T.KEYWORD || t.type === T.NUMBER)) return true;
      // 赋值运算符 := 两侧留空格(@i := @i + 1)
      if (t.type === T.OP && t.text === ':=') return true;
      if (prev.type === T.DOT) return false;
      if (prev.type === T.PAREN && prev.text === '(') return false;
      if (t.type === T.STRING && prev.type === T.STRING) return false;   // '' 相邻字符串不插空格
      if (prev.type === T.KEYWORD || prev.type === T.COMMA || prev.type === T.OP) return true;
      return pendingSpace;
    }

    for (let k = 0; k < toks.length; k++) {
      const t = toks[k];

      if (t.type === T.WS || t.type === T.NL) { pendingSpace = true; continue; }

      // 子句关键字 → 前置换行(缩进随括号层级加深;窄括号块内不拆)
      if (t.type === T.KEYWORD && !compact && CLAUSE_KW.has(t.text.toUpperCase()) && cur().trim() !== '') {
        const open = parenStack.length ? parenStack[parenStack.length - 1] : null;
        if (!open || open.wide) {
          const uc = t.text.toUpperCase();
          const bound = prev && prev.type === T.KEYWORD && BINDER_KW.has(prev.text.toUpperCase());
          if (!bound) newLine(clauseIndent() + ((uc === 'AND' || uc === 'OR') ? IND : 0));
        }
      }

      // 括号:进层/出层。层内换过行的,闭合 ) 回到父级缩进独占一行
      if (t.type === T.PAREN) {
        if (t.text === '(') {
          if (spaceBefore(t)) add(' ');
          add('(');
          // 只有"够宽"的括号块才允许内部拆子句;短子查询保持一行
          parenStack.push({ broken: false, wide: parenInlineWidth(toks, k) > INLINE_MAX });
        } else {
          const top = parenStack.pop();
          if (top && top.broken) newLine(clauseIndent());
          add(')');
        }
        prev = t; pendingSpace = false; continue;
      }

      if (t.type === T.STRING) {
        const sub = fmtString(t, curIndent);
        if (spaceBefore(t)) add(' ');
        if (sub.length === 1) add(sub[0]);
        else { add(sub[0]); for (let x = 1; x < sub.length; x++) { flush(); setCur(sub[x]); } }
        prev = t; pendingSpace = false; continue;
      }
      if (t.type === T.MACRO) {
        const sub = fmtMacro(t, curIndent);
        if (spaceBefore(t)) add(' ');
        if (sub.length === 1) add(sub[0]);
        else { add(sub[0]); for (let x = 1; x < sub.length; x++) { flush(); setCur(sub[x]); } }
        prev = t; pendingSpace = false; continue;
      }
      if (t.type === T.COMMENT) {
        if (spaceBefore(t)) add(' ');
        add(t.text);
        if (!compact) newLine(clauseIndent());
        prev = t; pendingSpace = false; continue;
      }

      const text = (t.type === T.KEYWORD) ? t.text.toUpperCase() : t.text;
      if (spaceBefore(t)) add(' ');
      add(text);
      prev = t; pendingSpace = false;
    }

    flush();
    return lines.filter(l => l.trim() !== '');
  }

  // 字符串 token → lines[](内部宏展开)
  function fmtString(t, lineIndent) {
    const segs = t.segs || [];
    if (!segs.length) return [t.text];
    let out = '\'';
    const lines = [];
    for (const seg of segs) {
      if (seg.kind === 'text') {
        out += seg.text || '';
      } else if (seg.kind === 'macro' && seg.token) {
        const mLines = fmtMacro(seg.token, lineIndent);
        if (mLines.length === 1) out += mLines[0];
        else {
          lines.push(out + mLines[0]);
          for (let x = 1; x < mLines.length - 1; x++) lines.push(mLines[x]);
          out = mLines[mLines.length - 1];
        }
      }
    }
    out += '\'';
    lines.push(out);
    return lines;
  }

  // 参数(顶层)是否含子句关键字 → 判断"这一段是不是一条查询"
  function partHasClause(part) {
    for (const tk of ((part && part.toks) || [])) {
      if (tk.type === T.KEYWORD && CLAUSE_KW.has(tk.text.toUpperCase())) return true;
    }
    return false;
  }
  function macroHasClause(t) {
    for (const p of (t.parts || [])) if (partHasClause(p)) return true;
    return false;
  }
  // 宏体是否含「本身是子查询」的嵌套宏(含字符串里的宏)
  // 对齐需求稿 §4.1:@nullValue(@sqlvalue(SELECT…)) 展开换行;
  // @getDeptCode(@form(x,y),4) 这类纯参数组合不展开(展开只会把参数拆散)
  function hasNestedQueryMacro(parts) {
    for (const p of (parts || [])) {
      for (const tk of (p.toks || [])) {
        if (tk.type === T.MACRO && macroHasClause(tk)) return true;
        if (tk.type === T.STRING && tk.segs) {
          for (const g of tk.segs) if (g && g.kind === 'macro' && g.token && macroHasClause(g.token)) return true;
        }
      }
    }
    return false;
  }
  // 展开判据:
  // ① 体内有子查询宏(@nullValue(@sqlvalue(SELECT…)) 这类嵌套)
  // ② @sqlset 语句级包装宏,体里是查询
  // ③ 自身宏体就是一条查询(@sqlvalue(select …))——体够宽才展开,
  //    短查询(@sqlvalue(select 1))保持一行,不为了形式统一把三个 token 拆三行
  function needsExpand(t) {
    if (hasNestedQueryMacro(t.parts)) return true;
    const ownQuery = (t.parts || []).some(partHasClause);
    if (!ownQuery) return false;
    if (String(t.name).toLowerCase() === 'sqlset') return true;
    return String(t.text || '').length > INLINE_MAX;
  }

  // 宏 token → lines[]
  function fmtMacro(t, lineIndent) {
    const name = t.name || '';
    const parts = t.parts || [];
    const isSqlset = String(name).toLowerCase() === 'sqlset';

    if (compact || parts.length === 0) {
      const inner = parts.map(p => fmtToks(p.toks, 0).join(' ').trim()).join(', ');
      return ['@' + name + '(' + inner + ')'];
    }
    // 叶子宏(体无子查询)→ 原文逐字保留,便于格式化后按宏文本替换
    if (!needsExpand(t)) return [t.text];

    const bodyIndent = lineIndent + IND;

    // @sqlset:<第一参数是查询 → 正常排版;第二参数起是值分隔符 → 原文逐字追加,
    // 绝不重排也不插空格(分隔符"紧跟逗号",多一个空格就改了语义)
    if (isSqlset) {
      const out = ['@' + name + '('];
      const sub = fmtToks(parts[0].toks, bodyIndent);
      for (let x = 0; x < sub.length; x++) {
        out.push(x === 0 ? (' '.repeat(bodyIndent) + sub[0]) : sub[x]);
      }
      let tail = '';
      for (let pi = 1; pi < parts.length; pi++) {
        const p = parts[pi];
        tail += ',' + (p.lead || '') + (p.toks || []).map(tk => tk.text).join('');
      }
      out.push(' '.repeat(lineIndent) + tail + ')');
      return out;
    }

    // 值宏:参数分隔符字节级保留(',' + p.lead 原样使用,不自行补空格)
    const lines = ['@' + name + '('];
    for (let pi = 0; pi < parts.length; pi++) {
      const p = parts[pi];
      if (!p.toks || p.toks.length === 0) {
        lines.push(pi === 0 ? (' '.repeat(bodyIndent) + (p.lead || '')) : (p.lead || ''));
      } else {
        const sub = fmtToks(p.toks, bodyIndent);
        for (let x = 0; x < sub.length; x++) {
          lines.push(x === 0 ? (' '.repeat(bodyIndent) + sub[0]) : sub[x]);
        }
      }
      if (pi < parts.length - 1) lines[lines.length - 1] += ',';
    }
    // 短尾合并:用末参数的 byte-exact lead 代替硬编码 ' '
    const closeLine = ' '.repeat(lineIndent) + ')';
    const li = lines.length - 1;
    if (li >= 1 && lines[li - 1].endsWith(',')) {
      const lastPart = parts[parts.length - 1];
      const byteLead = lastPart.lead || '';
      const tail = lines[li];
      const tailTrimmed = tail.replace(/^ +/, '');
      const merged = lines[li - 1] + byteLead + tailTrimmed + closeLine.trim();
      if (!tailTrimmed.includes('\n') && tailTrimmed.length < 40 && merged.length < 100) {
        lines[li - 1] = merged;
        lines.pop();
      } else {
        lines.push(closeLine);
      }
    } else {
      lines.push(closeLine);
    }
    return lines;
  }

  return fmtToks(tokens, 0).join('\n');
}

// ════════════════════════════════════════════════════════════
// 替换
// ════════════════════════════════════════════════════════════
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function replaceAll(text, pairs, options) {
  const opts = options || {};
  let result = String(text == null ? '' : text);

  for (const p of (pairs || [])) {
    const find = p.find || p.text || '';
    const value = p.value == null ? '' : String(p.value);
    if (!find) continue;
    const useQuoted = p.quoted !== undefined ? !!p.quoted : opts.quoted !== false;
    try {
      if (useQuoted) {
        result = result.replace(new RegExp("'" + escapeRe(find) + "'", 'g'), "'" + value + "'");
      } else {
        result = result.replace(new RegExp(escapeRe(find), 'g'), value);
      }
    } catch (e) { /* 忽略无效 pattern */ }
  }

  // 通用查找/替换
  if (opts.find) {
    const val = opts.findValue == null ? '' : String(opts.findValue);
    try {
      if (opts.findRegex) result = result.replace(new RegExp(opts.find, 'g'), val);
      else result = result.replace(new RegExp(escapeRe(opts.find), 'g'), val);
    } catch (e) { /* 无效正则:跳过 */ }
  }

  return result;
}

// ════════════════════════════════════════════════════════════
// JSON
// ════════════════════════════════════════════════════════════
function processJson(text, mode) {
  const src = String(text == null ? '' : text);
  const diagnostics = [];

  if (mode === 'validate' && src.trim() === '') {
    return { formatted: src, diagnostics, macros: [] };
  }

  try {
    const parsed = JSON.parse(src);
    const formatted = (mode === 'validate') ? src : JSON.stringify(parsed, null, 2);
    return { formatted, diagnostics, macros: [] };
  } catch (e) {
    const msg = String(e && e.message || 'JSON 解析失败');
    let ln = 1, cl = 1;
    const lc = msg.match(/line\s+(\d+)\s+column\s+(\d+)/i);
    const pos = msg.match(/position\s+(\d+)/i);
    if (lc) { ln = parseInt(lc[1], 10); cl = parseInt(lc[2], 10); }
    else if (pos) {
      const p = parseInt(pos[1], 10);
      const before = src.slice(0, p);
      ln = (before.match(/\n/g) || []).length + 1;
      cl = p - before.lastIndexOf('\n');
    }
    diagnostics.push({
      line: ln, col: cl, level: 'error', rule: 'json',
      message: 'JSON 解析错误: ' + msg,
    });
    return { formatted: src, diagnostics, macros: [] };
  }
}

// ════════════════════════════════════════════════════════════
// 自动修复:按诊断的 fixAt 从后往前插入缺失的 ( / ) / '
// 验证式:每次插入后重跑校验,可修复诊断减少才保留,否则回滚(宁缺毋滥)
// ════════════════════════════════════════════════════════════
function runValidate(text, funcMap) {
  const lexed = lex(text);
  const diag = [...lexed.diagnostics];
  validateParen(lexed.tokens, diag);
  validateAtBad(lexed.tokens, text, diag, funcMap);
  validateAtFunc(lexed.macros, funcMap, diag);
  suggestMissingQuote(text, diag);
  return diag;
}

// 辅助: offset → {line, col}
function offsetToPos(text, off) {
  if (off <= 0) return { line: 1, col: 1 };
  let line = 1;
  for (let k = 0; k < off && k < text.length; k++) {
    if (text[k] === '\n') { line++; }
  }
  const lastNl = text.lastIndexOf('\n', off);
  const col = off - lastNl;
  return { line, col };
}

// 启发式:引号未闭合时,搜索 =@macro(...)[,args]' 模式,提示缺开引号
function suggestMissingQuote(text, diagnostics) {
  if (!diagnostics.some(d => d.rule === 'paren' && d.message.includes('单引号'))) return;
  // 找 =@ 后跟完整宏调用 → 宏结束后紧跟 ' (即 =@macro()' 但缺少开引号)
  const re = /=@([A-Za-z_][A-Za-z0-9_]*)\([^)]*\)(?:,[A-Za-z0-9_]+\))?'/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const eqOff = m.index; // = 的绝对字符位置
    const pos = offsetToPos(text, eqOff);
    diagnostics.push({
      line: pos.line, col: pos.col, level: 'warn', rule: 'paren',
      message: '疑似缺少开引号:第 ' + eqOff + ' 字符处 =@' + m[1] + '(…) 后紧跟 \',宏值可能应包在引号内(如 =\'@macro);若在此补开引号,末尾的 \' 就不是多余的',
    });
    break; // 只提示第一处,避免刷屏
  }
}

function isFixable(d) {
  return typeof d.fixAt === 'number' && !!d.fix && (d.fixAt >= 0);
}

function insertFor(d) {
  if (typeof d.fixWhat === 'string' && d.fixWhat) return d.fixWhat;
  if (d.rule === 'paren' && d.message.includes('单引号')) return "'";
  if (d.message.includes('缺少左括号')) return '(';
  if (d.message.includes('缺少闭合')) {
    const m = d.fix.match(/补 (\d+) 个闭合括号/);
    return ')'.repeat(m ? parseInt(m[1], 10) : 1);
  }
  return '';
}

function autoFix(text, funcMap) {
  let work = text;
  const applied = [];
  const diff = [];
  const MAX_ROUNDS = 8;
  const WIN = 22;   // diff 局部前后文窗口

  // 落笔 + 记录 diff(原片段 / 新片段),统一出口
  const applyFix = (at, what, reason) => {
    const lo = Math.max(0, at - WIN);
    const oldFrag = work.slice(lo, Math.min(work.length, at + WIN));
    work = work.slice(0, at) + what + work.slice(at);
    const newFrag = work.slice(lo, Math.min(work.length, at + what.length + WIN));
    applied.push({ at, what, reason });
    diff.push({ at, insert: what, before: oldFrag, after: newFrag, reason });
  };

  // 接受判据:
  // ① 可修诊断数严格减少,且 ② 不得引入任何新的「非可修错误」
  // ②是關鍵:在文本末尾堆 ) 能消掉「未闭合」,却会引入「参数个数异常」——必须挡住
  const fixSig = (d) => d.rule + '|' + d.message;
  const fixableCount = (diag) => diag.filter(isFixable).length;
  // ATBAD(缺左括号)计数——局部判据:补一个 ( 就该少一个
  const atbadCount = (diag) =>
    diag.filter(d => d.rule === 'atfunc' && d.message.includes('缺少左括号')).length;
  const nonFixErrors = (diag) => {
    const m = new Map();
    for (const d of diag) {
      if (d.level !== 'error' || isFixable(d)) continue;
      const k = fixSig(d);
      m.set(k, (m.get(k) || 0) + 1);
    }
    return m;
  };
  const introducesNewError = (base, trial) => {
    const m = new Map(base);
    for (const d of trial) {
      if (d.level !== 'error' || isFixable(d)) continue;
      const k = fixSig(d);
      const left = (m.get(k) || 0) - 1;
      if (left < 0) return true;   // 基线里没有这条错误 → 新引入
      m.set(k, left);
    }
    return false;
  };

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const diag = runValidate(work, funcMap);
    const fixable = diag.filter(isFixable);
    if (fixable.length === 0) {
      return { sql: work, applied, diff, diagnostics: diag, stable: true };
    }

    const baseNonFix = nonFixErrors(diag);
    const baseErr = diag.filter(d => d.level === 'error').length;
    let made = false;
    // 一级候选:只自动修「缺左括号」——ATBAD token 后一位是唯一确定位置,补上必是改进
    const ordered = fixable.filter(d => d.fixWhat === '(');

    const baseAtbad = atbadCount(diag);
    for (const d of ordered) {
      const what = insertFor(d);
      if (!what) continue;
      const trial = work.slice(0, d.fixAt) + what + work.slice(d.fixAt);
      const trialDiag = runValidate(trial, funcMap);
      if (atbadCount(trialDiag) >= baseAtbad) continue;
      applyFix(d.fixAt, what, d.message);
      made = true;
      break;
    }

    // 1.5 级候选:引号对不齐(奇数个 ') → 在 )+空格 后试探补 '
    // 字符串中间缺 ' 会导致整段解析错位,fixAt 往往是文本末尾,必须另找位置
    // 不要求 fixable 立即减少——补 ' 稳定了字符串边界后,后续 ) 修复才能工作
    if (!made) {
      const quoteCount = (work.match(/'/g) || []).length;
      if (quoteCount % 2 === 1) {
        // 收集候选:每个 ) 后面跟上空格+SQL连词(and/or/where/, )
        const cand = new Set();
        for (let j = 0; j < work.length - 4; j++) {
          if (work[j] === ')' && /^\s+(and|or|where|,)/i.test(work.slice(j + 1, Math.min(j + 9, work.length)))) {
            cand.add(j + 1); // 在 ) 之后、空格之前
            if (j > 0 && work[j - 1] === ')') cand.add(j); // 连续 )):在第二个 ) 之前(两个 ) 之间)也试
          }
        }
        // 从后往前试(避免位置偏移),取总错误数不增加且不引入非可修错误最少者
        const baseErrAll = diag.filter(d => d.level === 'error').length;
        let bestAt = -1, bestErr = baseErrAll + 1;
        const sorted = [...cand].sort((a, b) => b - a);
        for (const at of sorted) {
          const trial = work.slice(0, at) + "'" + work.slice(at);
          const trialDiag = runValidate(trial, funcMap);
          const trialErr = trialDiag.filter(d => d.level === 'error').length;
          if (trialErr <= baseErrAll && !introducesNewError(baseNonFix, trialDiag)) {
            bestAt = at; bestErr = trialErr;
            break;
          }
        }
        if (bestAt >= 0) {
          applyFix(bestAt, "'", '奇数引号:缺闭合单引号,在此补 \'');
          made = true;
        }
      }
    }

    // 二级候选:源文本里 `,IDENT'` 形态漏了 ) (如 ',ELSE' 应为 ',ELSE)' )。
    // 位置由模式直接给出,比「宏扫描停在 EOF」可靠得多;仍要求错误数严格下降且不引入新错误
    if (!made) {
      const re = /,([A-Za-z_][A-Za-z0-9_]*)'/g;
      let m;
      while ((m = re.exec(work)) !== null) {
        const at = m.index + m[0].length - 1;   // ' 的位置,) 插在它前面
        const trial = work.slice(0, at) + ')' + work.slice(at);
        const trialDiag = runValidate(trial, funcMap);
        const err = trialDiag.filter(d => d.level === 'error').length;
        if (err >= baseErr) continue;
        if (introducesNewError(baseNonFix, trialDiag)) continue;
        applyFix(at, ')', `,${m[1]}' 漏了闭合 )`);
        made = true;
        break;
      }
    }

    // 三级候选:源文本里 `'` 后紧跟 `,` 且为宏参数语境 → 字符串后缺 )
    // 常见于 @sqlvalue(…'@getDeptCode(…,2)'),ELSE) 中 @sqlvalue 收尾 ) 缺失
    if (!made) {
      const quoteComma = /'\s*,/g;
      let qm;
      while ((qm = quoteComma.exec(work)) !== null) {
        const at = qm.index + 1; // ' 的位置, ) 插在它后面
        const trial = work.slice(0, at) + ')' + work.slice(at);
        const trialDiag = runValidate(trial, funcMap);
        const err = trialDiag.filter(d => d.level === 'error').length;
        if (err < baseErr && !introducesNewError(baseNonFix, trialDiag)) {
          applyFix(at, ')', '字符串后缺收尾 )');
          made = true;
          break;
        }
      }
    }

    // 四级候选:文本末尾补 ) —— 最外层宏的收尾 ) 位置是确定的(必在输入末尾),
    // 但内层宏的缺 ) 位置不定 → 只有「严格减少错误且不引入新错误」才接受
    if (!made && diag.some(d => d.fixWhat === ')')) {
      const trial = work + ')';
      const trialDiag = runValidate(trial, funcMap);
      const err = trialDiag.filter(d => d.level === 'error').length;
      if (err < baseErr && !introducesNewError(baseNonFix, trialDiag)) {
        applyFix(work.length, ')', '最外层宏缺收尾 )');
        made = true;
      }
    }
    if (!made) {
      return { sql: work, applied, diff, diagnostics: runValidate(work, funcMap), stable: false };
    }
  }

  return { sql: work, applied, diff, diagnostics: runValidate(work, funcMap), stable: false };
}

// ════════════════════════════════════════════════════════════
// 主入口
// ════════════════════════════════════════════════════════════
function process(input) {
  const inp = input || {};
  const text = String(inp.text == null ? '' : inp.text);
  const language = inp.language || 'sql';
  const mode = inp.mode || 'format';
  const options = inp.options || {};
  const funcMap = inp.funcList ? buildFuncMap(inp.funcList) : null;
  const validate = inp.validate !== false; // 默认开启验证;false=快速模式跳过一切验证/修复

  if (language === 'json') {
    if (mode === 'replace') {
      const replaced = replaceAll(text, options.replacePairs, options);
      return processJson(replaced, 'format');
    }
    return processJson(text, mode);
  }

  // ── SQL ──
  const order = options.order || 'replace-then-format';
  const hasReplace = !!(options.replacePairs && options.replacePairs.length) || !!options.find;

  if (mode === 'replace') {
    const replaced = replaceAll(text, options.replacePairs, options);
    const lexed = lex(replaced);
    const diag = validate ? [...lexed.diagnostics] : [];
    if (validate) {
      validateParen(lexed.tokens, diag);
      validateAtBad(lexed.tokens, replaced, diag, funcMap);
      validateAtFunc(lexed.macros, funcMap, diag);
    }
    let formatted;
    if (hasReplace && order === 'replace-then-format') formatted = format(lexed.tokens, { compact: options.compact });
    else if (order === 'format-then-replace') {
      const pre = lex(text);
      const f = format(pre.tokens, { compact: options.compact });
      formatted = replaceAll(f, options.replacePairs, options);
    } else formatted = replaced;
    // 渲染 token 基于最终文本
    const finalText = formatted;
    const rl = lex(finalText);
    return { formatted, diagnostics: diag, macros: extractMacros(lexed.macros), tokens: rl.tokens };
  }

  // format / validate / fix
  let workText = text;
  if (hasReplace && order === 'replace-then-format') {
    workText = replaceAll(text, options.replacePairs, options);
  }

  // ── fix 模式:自动补括号/引号 + 输出格式化结果 ──────────────
  if (mode === 'fix') {
    const fixed = autoFix(workText, funcMap);
    // 修复后再格式化:交付给用户的就是排好版的 SQL
    const rl = lex(fixed.sql);
    let formatted = format(rl.tokens, { compact: options.compact });
    // 安全闸门:格式化器假定输入合法。若修复后仍有残留错误,它可能擅自「补齐」结构
    // (实测:未闭合字符串会被补上一个 ' ,等于改了内容)→ 用去空白等价性校验,不等价就退回
    const norm = (s) => s.replace(/\s+/g, '').toLowerCase();
    const formatSafe = norm(formatted) === norm(fixed.sql);
    if (!formatSafe) formatted = fixed.sql;
    // 以格式化结果重新校验(格式化不该引入新问题;若有,如实报出)
    const fmtDiag = runValidate(formatted, funcMap);
    return {
      sql: fixed.sql,                 // 修复后(未格式化,便于对照)
      formatted,                      // 修复 + 格式化(交付用;不安全时=sql)
      formatSafe,                     // false = 格式化会改动内容,已自动退回
      diff: fixed.diff,               // 每处改动的局部前后文
      applied: fixed.applied,
      diagnostics: fmtDiag.length ? fmtDiag : fixed.diagnostics,
      stable: fixed.stable,
      macros: extractMacros(rl.macros),
      tokens: rl.tokens,
    };
  }

  const lexed = lex(workText);
  const diag = validate ? [...lexed.diagnostics] : [];
  if (validate) {
    validateParen(lexed.tokens, diag);
    validateAtBad(lexed.tokens, workText, diag, funcMap);
    validateAtFunc(lexed.macros, funcMap, diag);
    suggestMissingQuote(workText, diag);
  }

  let formatted;
  if (mode === 'format') {
    formatted = format(lexed.tokens, { compact: options.compact });
    if (hasReplace && order === 'format-then-replace') {
      formatted = replaceAll(formatted, options.replacePairs, options);
    }
  } else {
    formatted = workText;
  }

  const renderLex = lex(formatted);
  return {
    formatted,
    diagnostics: diag,
    macros: extractMacros(lexed.macros),
    tokens: renderLex.tokens,
  };
}

module.exports = {
  lex,
  format,
  process,
  processJson,
  extractMacros,
  replaceAll,
  runConcatenationCheck,
  validateParen,
  validateAtFunc,
  validateAtBad,
  buildFuncMap,
  DEFAULT_FUNCS,
  T,
  KEYWORDS,
  CLAUSE_KW,
};