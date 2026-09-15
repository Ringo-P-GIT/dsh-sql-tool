/**
 * dsh-sql-tool —— SQL(含@宏)与JSON的格式化/校验/自动修复工具 (Host 端)
 *
 * 职责:
 * 1. 注册 agent tool `sql_tool`，供对话中 agent 调用。
 * 2. 注册 HTTP 端点 POST /dsh-sql-tool/api/process，供客户端面板调用。
 * 3. 包装 core/engine.cjs 的格式化/校验/替换能力。
 */

import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

/** 插件元数据 */
const inject = ['webServer', 'tools', 'settings']
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const ENGINE_PATH = join(PLUGIN_DIR, '..', 'core', 'engine.cjs')
const FUNCTIONS_PATH = join(homedir(), '.dsh', 'sql-tool-functions.json')

const _require = createRequire(import.meta.url)
let _engine = null

function getEngine() {
  if (!_engine) {
    try {
      delete _require.cache[_require.resolve(ENGINE_PATH)]
      _engine = _require(ENGINE_PATH)
    } catch (err) {
      console.error('[dsh-sql-tool] 加载引擎失败:', err.message)
    }
  }
  return _engine
}

function loadFuncList() {
  try {
    if (existsSync(FUNCTIONS_PATH)) {
      const raw = readFileSync(FUNCTIONS_PATH, 'utf8')
      const data = JSON.parse(raw)
      return Array.isArray(data.functions) ? data.functions : []
    }
  } catch (err) {
    console.error('[dsh-sql-tool] 读取函数清单失败:', err.message)
  }
  return null
}

/**
 * 去掉值为 undefined 的键。
 *
 * 为什么必须做:DSH 对 agent tool 的返回值有「无损 JSON」校验。JSON.stringify 遇到
 * undefined 会静默丢弃该键,校验方一比对就发现键少了 → 整个工具调用失败,报
 * `value is not lossless JSON`(HTTP 端点走 JSON.stringify 直发,所以面板照常能用,
 * 只有 agent 调用会炸——这也是这个 bug 长期藏在「能用」假象里的原因)。
 *
 * 背景:engine.process() 在 format 模式下不返回 formatSafe/diff/sql/applied/stable
 * (见 core/engine.cjs 的 format 分支),下面若无条件平铺这些字段就全是 undefined。
 */
function dropUndef(obj) {
  const out = {}
  for (const k of Object.keys(obj)) if (obj[k] !== undefined) out[k] = obj[k]
  return out
}

function processSql(text, mode, options, validate) {
  const engine = getEngine()
  const funcList = loadFuncList()
  if (engine && typeof engine.process === 'function') {
    const result = engine.process({ text, mode: options?.replacePairs ? 'replace' : mode, funcList: funcList || undefined, validate: validate === false ? false : undefined, replacePairs: options?.replacePairs, order: options?.order, compact: options?.compact })
    return dropUndef({ formatted: result.formatted ?? text, formatSafe: result.formatSafe, diagnostics: result.diagnostics ?? [], macros: result.macros ?? [], diff: result.diff, sql: result.sql, applied: result.applied, stable: result.stable })
  }
  return { formatted: text, formatSafe: true, diagnostics: [{ line: 1, col: 1, level: 'warn', rule: 'engine', message: '核心引擎未加载，返回原文' }], macros: [] }
}

function processJson(text, mode) {
  if (mode === 'validate') {
    try { JSON.parse(text); return { diagnostics: [] } }
    catch (parseErr) {
      const match = parseErr.message.match(/position\s+(\d+)/i)
      const pos = match ? parseInt(match[1]) : 0
      return { diagnostics: [{ line: 1, col: pos, level: 'error', rule: 'json', message: parseErr.message }] }
    }
  }
  const parsed = JSON.parse(text)
  return { formatted: JSON.stringify(parsed, null, 2) }
}

async function handleApiRequest(req, res) {
  let body = ''
  for await (const chunk of req) body += chunk
  let input
  try { input = JSON.parse(body) }
  catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid JSON body' })); return }
  const { text, language = 'sql', mode = 'format', validate, options = {} } = input
  if (!text || typeof text !== 'string') { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'text is required' })); return }
  try {
    const result = language === 'json' ? processJson(text, mode) : processSql(text, mode, options, validate)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
  } catch (err) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: err.message })) }
}

/**
 * 插件入口 —— Cordis 直接接受函数作为 apply 回调
 */
export default function apply(ctx) {
  const { webServer, tools } = ctx
  getEngine()

  // agent tool
  try {
    tools.register({
      name: 'sql_tool',
      description: 'SQL(含@宏)与JSON的格式化/校验/自动补全/替换工具。支持@form/@sqlvalue/@nullValue/@getDeptCode/@sqlset/@processId等宏;mode=format|validate|fix|replace;设validate=false跳过验证(快速模式)。',
      parameters: { type: 'object', properties: { text: { type: 'string', description: '待处理的SQL或JSON文本' }, language: { type: 'string', description: '语言类型', default: 'sql' }, mode: { type: 'string', description: 'format/validate/fix/replace', default: 'format' }, validate: { type: 'boolean', description: '默认 true;设 false 跳过全部验证/修复,仅做格式化(快速模式)', default: true }, options: { type: 'object', description: '可选参数', properties: { compact: { type: 'boolean' }, replacePairs: { type: 'array', items: { type: 'object', properties: { find: { type: 'string' }, value: { type: 'string' }, quoted: { type: 'boolean' } } } }, order: { type: 'string', default: 'replace-then-format' } } } }, required: ['text'] },
      output: { schema: { type: 'object', properties: { formatted: { type: 'string' }, formatSafe: { type: 'boolean' }, diagnostics: { type: 'array', items: { type: 'object', properties: { line: { type: 'number' }, col: { type: 'number' }, level: { type: 'string' }, rule: { type: 'string' }, message: { type: 'string' } } } }, macros: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, params: { type: 'number' }, count: { type: 'number' } } } } } },
        render: (args, value) => {
          const v = value || {}
          const parts = []
          if (v.formatted) { parts.push('```sql'); parts.push(v.formatted); parts.push('```') }
          if (Array.isArray(v.diagnostics)) for (const d of v.diagnostics) parts.push(`[${String(d.level).toUpperCase()}] ${d.rule}: ${d.message} (${d.line}:${d.col})`)
          // DSH 契约:@deepseek-ai/dsh-tools 的 ToolDefinition.output.render 必须返回
          // ContentBlock[]。返回裸字符串不会抛错(snapshotProjection 只校验是不是合法 JSON),
          // 但消费端拿不到内容块,整个工具结果显示成 "(no output)" —— 沉默失败,比抛错更难查。
          return [{ type: 'text', text: parts.length > 0 ? parts.join('\n') : '(sql_tool 无输出)' }]
        } },
      execute: (args) => {
        const { text, language = 'sql', mode = 'format', validate, options = {} } = args
        if (!text || typeof text !== 'string') return { formatted: '', diagnostics: [{ line: 0, col: 0, level: 'error', rule: 'input', message: 'text参数必填' }], macros: [] }
        if (language === 'json') return processJson(text, mode)
        return processSql(text, mode, options, validate)
      }
    })
    console.log('[dsh-sql-tool] agent tool: sql_tool 已注册')
  } catch (err) {
    console.error('[dsh-sql-tool] 注册 agent tool 失败:', err.message)
  }

  // HTTP API — DSH webServer 使用 register() 而非 Express
  if (webServer && typeof webServer.register === 'function') {
    webServer.register({ kind: 'exact', path: '/dsh-sql-tool/api/process', handler: handleApiRequest })
    console.log('[dsh-sql-tool] HTTP端点 /dsh-sql-tool/api/process 已注册')
  }
}

apply.inject = inject