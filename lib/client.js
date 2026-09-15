/**
 * dsh-sql-tool —— SQL(含@宏)与JSON的格式化/校验/自动修复工具 (浏览器半侧)
 *
 * 标准 DSH 客户端插件格式：factory 返回 { apply, inject, name }。
 * 通过 shell.overlay 插槽挂载 SQL 工具面板（React 组件，与 dsh-reqsys 同款机制）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-sql-tool',

  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var react = require('react')
    var h = react.createElement

    var API_URL = '/dsh-sql-tool/api/process'
    var CSS_ID = 'dsh-sql-tool/css'

    // ── CSS 注入 ────────────────────────────────────────────────
    if (typeof document !== 'undefined' && !document.querySelector('style[data-plugin-css="' + CSS_ID + '"]')) {
      var tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-sql-tool'
      tag.dataset.pluginCss = CSS_ID
      tag.textContent = [
        '.dsh-sql-fab{position:fixed;bottom:72px;right:18px;z-index:900;width:46px;height:46px;border-radius:50%;border:none;background:#4a7cff;color:#fff;font-size:12px;font-weight:700;letter-spacing:.5px;cursor:pointer;box-shadow:0 4px 16px rgba(74,124,255,.45);display:flex;align-items:center;justify-content:center;font-family:inherit;transition:transform .15s}',
        '.dsh-sql-fab:hover{transform:scale(1.06)}',
        '.dsh-sql-fab.is-open{background:#2f5be0}',
        '.dsh-sql-wrap{position:fixed;bottom:128px;right:18px;z-index:900;width:680px;height:640px;min-width:420px;min-height:360px;max-width:calc(100vw - 40px);max-height:calc(100vh - 160px);display:flex;flex-direction:column;border-radius:12px;background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-primary,#111);box-shadow:0 12px 48px rgba(0,0,0,.28);border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));overflow:hidden;resize:both;font-family:inherit}',
        '.dsh-sql-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));font-size:14px;font-weight:600}',
        '.dsh-sql-head select{padding:3px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.14));font-size:12px;background:var(--dsw-alias-interactive-bg,#fff);color:inherit;font-family:inherit;cursor:pointer}',
        '.dsh-sql-close{margin-left:auto;border:none;background:transparent;color:inherit;font-size:18px;line-height:1;cursor:pointer;opacity:.6;padding:0 2px}',
        '.dsh-sql-close:hover{opacity:1}',
        '.dsh-sql-body{padding:12px 14px;display:flex;flex-direction:column;gap:10px;overflow-y:auto}',
        '.dsh-sql-body textarea{width:100%;min-height:220px;padding:10px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.14));border-radius:8px;font-family:Consolas,"Courier New",monospace;font-size:12.5px;line-height:1.55;resize:vertical;box-sizing:border-box;background:var(--dsw-alias-bg-input,#fff);color:inherit;outline:none}',
        '.dsh-sql-body textarea:focus{border-color:#4a7cff;box-shadow:0 0 0 3px rgba(74,124,255,.16)}',
        '.dsh-sql-bar{display:flex;gap:6px;flex-wrap:wrap}',
        '.dsh-sql-bar button{padding:6px 13px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.14));background:var(--dsw-alias-interactive-bg,#fff);color:inherit;font-size:12.5px;cursor:pointer;font-family:inherit;transition:all .15s}',
        '.dsh-sql-bar button:hover{border-color:#4a7cff}',
        '.dsh-sql-bar button.primary{background:#4a7cff;color:#fff;border-color:#4a7cff}',
        '.dsh-sql-bar button.primary:hover{filter:brightness(1.08)}',
        '.dsh-sql-bar button:disabled{opacity:.5;cursor:default}',
        '.dsh-sql-out{position:relative;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));border-radius:8px;background:var(--dsw-alias-bg-code,rgba(0,0,0,.035));padding:10px;min-height:120px;max-height:320px;overflow:auto}',
        '.dsh-sql-out pre{margin:0;font-family:Consolas,"Courier New",monospace;font-size:12.5px;line-height:1.55;white-space:pre-wrap;word-break:break-word}',
        '.dsh-sql-copy{position:absolute;top:6px;right:6px;padding:3px 8px;font-size:11px;border-radius:4px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.14));background:var(--dsw-alias-interactive-bg,#fff);color:inherit;cursor:pointer;font-family:inherit}',
        '.dsh-sql-diags{display:flex;flex-direction:column;gap:2px;font-size:12px;max-height:140px;overflow-y:auto;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));border-radius:8px;padding:6px 8px}',
        '.dsh-sql-diag.err{color:#d93025}',
        '.dsh-sql-diag.warn{color:#c77700}',
        '.dsh-sql-empty{opacity:.55;font-size:12.5px}',
      ].join('\n')
      document.head.appendChild(tag)
    }

    // ── API ─────────────────────────────────────────────────────
    function callApi(text, language, mode, options) {
      return fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text, language: language, mode: mode, options: options || {} })
      }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status)
        return r.json()
      })
    }

    // ── React 面板 ──────────────────────────────────────────────
    function SqlToolApp() {
      var textState = react.useState('')
      var text = textState[0], setText = textState[1]
      var outState = react.useState('')
      var output = outState[0], setOutput = outState[1]
      var diagState = react.useState(null)
      var diags = diagState[0], setDiags = diagState[1]
      var langState = react.useState('sql')
      var lang = langState[0], setLang = langState[1]
      var busyState = react.useState(false)
      var busy = busyState[0], setBusy = busyState[1]
      var openState = react.useState(false)
      var open = openState[0], setOpen = openState[1]
      var errState = react.useState(null)
      var error = errState[0], setError = errState[1]
      var appliedState = react.useState(null)
      var applied = appliedState[0], setApplied = appliedState[1]

      function run(mode) {
        if (!text.trim()) { setOutput(''); setDiags(null); setError('请输入内容'); return }
        setBusy(true); setError(null); setApplied(null)
        callApi(text, lang, mode).then(function (r) {
          setOutput(r.formatted !== undefined ? r.formatted : '')
          setDiags(r.diagnostics && r.diagnostics.length ? r.diagnostics : null)
          if (mode === 'fix' && r.applied) setApplied(r.applied)
        }).catch(function (e) {
          setError('请求失败: ' + e.message)
        }).then(function () { setBusy(false) })
      }

      function copyOut() {
        var value = output || ''
        if (navigator.clipboard) navigator.clipboard.writeText(value).catch(function () {})
      }

      var fab = h('button', {
        className: 'dsh-sql-fab' + (open ? ' is-open' : ''),
        title: 'SQL / JSON 工具',
        onClick: function () { setOpen(!open) }
      }, 'SQL')

      if (!open) return fab

      var panel = h('div', { className: 'dsh-sql-wrap' },
        h('div', { className: 'dsh-sql-head' },
          h('span', null, 'SQL / JSON 工具'),
          h('select', {
            value: lang,
            onChange: function (e) { setLang(e.target.value) }
          },
            h('option', { value: 'sql' }, 'SQL'),
            h('option', { value: 'json' }, 'JSON')
          ),
          h('button', { className: 'dsh-sql-close', onClick: function () { setOpen(false) } }, '×')
        ),
        h('div', { className: 'dsh-sql-body' },
          h('textarea', {
            placeholder: lang === 'json' ? '粘贴 JSON...' : '粘贴 SQL（支持 @form / @sqlvalue / @nullValue / @getDeptCode / @sqlset / @processId 等宏）...',
            value: text,
            onChange: function (e) { setText(e.target.value) },
            spellCheck: false
          }),
          h('div', { className: 'dsh-sql-bar' },
            h('button', { className: 'primary', disabled: busy, onClick: function () { run('format') } }, busy ? '处理中…' : '格式化'),
            h('button', { disabled: busy, onClick: function () { run('validate') } }, '校验'),
            h('button', { disabled: busy, onClick: function () { run('fix') } }, '修复'),
            h('button', { disabled: busy, onClick: function () { setText(''); setOutput(''); setDiags(null); setError(null) } }, '清空')
          ),
          applied ? h('div', { style: { fontSize: 12, color: '#3fb950', padding: '4px 0', fontWeight: 500 } }, '已自动修复 ' + applied + ' 处') : null,
          error ? h('div', { className: 'dsh-sql-diag err' }, error) : null,
          h('div', { className: 'dsh-sql-out' },
            h('button', { className: 'dsh-sql-copy', onClick: copyOut }, '复制'),
            output ? h('pre', null, output) : h('div', { className: 'dsh-sql-empty' }, '结果将显示在这里')
          ),
          diags ? h('div', { className: 'dsh-sql-diags' },
            diags.map(function (d, i) {
              return h('div', {
                key: i,
                className: 'dsh-sql-diag ' + (d.level === 'error' ? 'err' : 'warn')
              }, (d.level === 'error' ? '✗ ' : '⚠ ') + (d.line || '?') + ':' + (d.col || '?') + '  ' + (d.message || ''))
            })
          ) : null
        )
      )

      return h('div', null, fab, panel)
    }

    // ── 插件 apply ──────────────────────────────────────────────
    var name = 'dsh-sql-tool'
    var inject = ['slots']

    function apply(ctx, config) {
      ctx.slots.inject('shell.overlay', function* () {
        yield ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-sql-tool',
          order: 2500
        }, function (ownerProps) {
          return h(SqlToolApp, ownerProps || {})
        })
      })
    }

    return { apply: apply, inject: inject, name: name }
  }
})