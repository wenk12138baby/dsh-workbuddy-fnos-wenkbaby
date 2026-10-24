/**
 * dsh-workbuddy-fnos-wenkbaby —— 浏览器半身
 *
 * 向 Web shell 贡献一个设置分区（settings.section），提供：
 *   - 账号列表（国际版 / 国内版分组）
 *   - 从本机读取凭据（PC 端零操作）
 *   - 导出凭据（给别人用）
 *   - 导入凭据（fnOS 端）
 *   - 无二进制时查询官方 Linux 包
 *
 * 数据走插件自己的同源路由 `/api/workbuddy-fnos/*`，与 Host 半身同一个进程。
 *
 * 手写 ModuleLoader 包：无构建步骤，只依赖 shell 已提供的 React。
 * 颜色全部取自主题变量，深浅色切换都能用。
 *
 * @module dsh-workbuddy-fnos-wenkbaby/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-workbuddy-fnos-wenkbaby',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports

    const React = require('react')
    const { createElement: h, Fragment, useState, useEffect, useCallback } = React

    /** 本插件的服务端路由前缀。 */
    const API = '/api/workbuddy-fnos'

    /** slots / locale 是 shell 提供的服务。 */
    const inject = ['slots', 'locale']

    const NS = 'settings.workbuddyFnos'

    // ── 文案 ──────────────────────────────────────────────────────────────
    const DICT = {
      zh: {
        'nav': 'WorkBuddy 接入',
        'meta.title': 'WorkBuddy 接入',
        'meta.description': '把 WorkBuddy / CodeBuddy 的模型接进 DeepSeek Harness，支持国际版与国内版双账号。',
        'list.title': '已接入账号',
        'list.empty': '尚未导入任何账号。',
        'btn.readLocal': '从本机读取凭据',
        'btn.export': '导出凭据',
        'btn.clear': '清空全部账号',
        'btn.pickFile': '选择文件…',
        'btn.import': '导入',
        'btn.query': '查询官方 Linux 包',
        'import.title': '导入凭据',
        'import.hint': '在装有 WorkBuddy 的电脑上点「导出凭据」，把得到的 JSON 粘贴到下面，或直接选择文件。',
        'import.placeholder': '把 workbuddy-export.json 的内容粘贴到这里…',
        'warn.plaintext': '⚠️ 导出的文件包含明文访问令牌。任何拿到它的人都能使用你的 WorkBuddy 额度。请只在自己的设备间传输，不要发送给他人或上传到网盘、聊天群、代码仓库。',
        'noBinary.title': '没有检测到 WorkBuddy',
        'noBinary.hint': '当前机器上没有 WorkBuddy 客户端，无法直接读取凭据。你可以用另一台电脑导出后导入。',
        'status.reading': '正在读取本机凭据…',
        'status.imported': '已导入：新增 {added} 个，更新 {updated} 个',
        'status.exported': '已生成导出文件。请注意保密。',
        'status.cleared': '已清空',
        'status.needInput': '请先粘贴内容或选择文件',
        'status.fileLoaded': '已读取文件：{name}',
        'status.querying': '正在查询…',
        'status.queryOk': '官方最新版 {version}（{platform}）',
        'account.unknown': '(未命名)',
        'account.expiresIn': '{days} 天后到期',
        'account.expired': '已过期',
        'confirm.clear': '确认清空本插件保存的全部账号？此操作不可撤销。',
        'global.name': 'WorkBuddy（国际版）',
        'cn.name': 'CodeBuddy（国内版）',
        'error.generic': '操作失败',
      },
      en: {
        'nav': 'WorkBuddy',
        'meta.title': 'WorkBuddy',
        'meta.description': 'Bring WorkBuddy / CodeBuddy models into DeepSeek Harness. Supports both global and CN accounts.',
        'list.title': 'Connected accounts',
        'list.empty': 'No accounts imported yet.',
        'btn.readLocal': 'Read from this machine',
        'btn.export': 'Export credentials',
        'btn.clear': 'Remove all accounts',
        'btn.pickFile': 'Choose file…',
        'btn.import': 'Import',
        'btn.query': 'Check official Linux build',
        'import.title': 'Import credentials',
        'import.hint': 'On a machine with WorkBuddy, click "Export credentials", then paste the JSON below or pick the file.',
        'import.placeholder': 'Paste the content of workbuddy-export.json here…',
        'warn.plaintext': '⚠️ Exported files contain plaintext access tokens. Anyone holding one can use your WorkBuddy quota. Transfer only between your own devices.',
        'noBinary.title': 'WorkBuddy not found',
        'noBinary.hint': 'WorkBuddy is not installed on this machine, so credentials cannot be read locally. Export from another machine and import here.',
        'status.reading': 'Reading local credentials…',
        'status.imported': 'Imported: {added} added, {updated} updated',
        'status.exported': 'Export file generated. Keep it private.',
        'status.cleared': 'Cleared',
        'status.needInput': 'Paste content or choose a file first',
        'status.fileLoaded': 'Loaded file: {name}',
        'status.querying': 'Querying…',
        'status.queryOk': 'Latest official build {version} ({platform})',
        'account.unknown': '(unnamed)',
        'account.expiresIn': 'expires in {days} days',
        'account.expired': 'expired',
        'confirm.clear': 'Remove all accounts saved by this plugin? This cannot be undone.',
        'global.name': 'WorkBuddy (Global)',
        'cn.name': 'CodeBuddy (CN)',
        'error.generic': 'Operation failed',
      },
    }

    /** 简易 API 调用。 */
    async function api(path, options = {}) {
      const response = await fetch(API + path, {
        headers: { 'content-type': 'application/json' },
        ...options,
      })
      const text = await response.text()
      let payload
      try {
        payload = JSON.parse(text)
      } catch {
        payload = { ok: false, error: text.slice(0, 200) }
      }
      if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`)
      return payload
    }

    /** 触发浏览器下载。 */
    function downloadJson(filename, doc) {
      const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = filename
      anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }

    // ── 样式 ──────────────────────────────────────────────────────────────
    const CSS = `
.wbfn { display: flex; flex-direction: column; gap: 14px; font-size: 14px; }
.wbfn__row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.wbfn__btn {
  padding: 7px 14px; border-radius: 7px; cursor: pointer;
  border: 1px solid var(--dsh-border, #c9d1d9);
  background: var(--dsh-surface, #fff); color: inherit;
  font-size: 13px; line-height: 1.2; font-family: inherit;
}
.wbfn__btn:hover:not(:disabled) { background: var(--dsh-hover, #f3f4f6); }
.wbfn__btn:disabled { opacity: .5; cursor: not-allowed; }
.wbfn__btn--primary { background: var(--dsh-accent, #1a3a7a); color: #fff; border-color: transparent; }
.wbfn__btn--danger { color: #b42318; border-color: #f3c2bd; }
.wbfn__card {
  border: 1px solid var(--dsh-border, #e3e8ef); border-radius: 10px;
  padding: 13px 15px; display: flex; flex-direction: column; gap: 6px;
}
.wbfn__card--global { border-left: 4px solid #4a7ac8; }
.wbfn__card--cn { border-left: 4px solid #d9822b; }
.wbfn__title { font-weight: 600; font-size: 14px; }
.wbfn__meta { color: var(--dsh-muted, #667085); font-size: 12.5px; line-height: 1.7; }
.wbfn__warn {
  background: #fff8e6; border: 1px solid #f0d58c; color: #7a5c00;
  border-radius: 7px; padding: 9px 12px; font-size: 12.5px; line-height: 1.6;
}
.wbfn__hint { color: var(--dsh-muted, #667085); font-size: 12px; line-height: 1.6; }
.wbfn__empty { color: var(--dsh-muted, #667085); padding: 8px 0; font-size: 13px; }
.wbfn__textarea {
  width: 100%; min-height: 88px; font-family: ui-monospace, SFMono-Regular, monospace;
  font-size: 12px; padding: 8px; border-radius: 6px; box-sizing: border-box;
  border: 1px solid var(--dsh-border, #c9d1d9);
  background: var(--dsh-surface, #fff); color: inherit; resize: vertical;
}
.wbfn__status { font-size: 12.5px; min-height: 18px; }
.wbfn__status--ok { color: #1a7f37; }
.wbfn__status--err { color: #b42318; }
`

    /** 注入样式（幂等）。 */
    function ensureStyle() {
      const id = 'wbfn-style'
      if (document.getElementById(id)) return
      const style = document.createElement('style')
      style.id = id
      style.textContent = CSS
      document.head.appendChild(style)
    }

    // ── 主组件 ────────────────────────────────────────────────────────────
    function SettingsPage() {
      const [state, setState] = useState({ loading: true, data: null })
      const [status, setStatus] = useState({ text: '', kind: '' })
      const [text, setText] = useState('')
      const [busy, setBusy] = useState('')

      const setOk = useCallback((msg) => setStatus({ text: msg, kind: 'ok' }), [])
      const setErr = useCallback((msg) => setStatus({ text: msg, kind: 'err' }), [])

      const refresh = useCallback(async () => {
        try {
          const data = await api('/status')
          setState({ loading: false, data })
        } catch (error) {
          setState({ loading: false, data: null })
          setErr(`无法连接插件后端：${error.message}`)
        }
      }, [setErr])

      useEffect(() => { void refresh() }, [refresh])

      const run = useCallback(async (key, fn) => {
        setBusy(key)
        try {
          await fn()
        } catch (error) {
          setErr(error.message || '操作失败')
        } finally {
          setBusy('')
        }
      }, [setErr])

      const data = state.data
      const accounts = data?.accounts ?? []

      const onReadLocal = () => run('local', async () => {
        setStatus({ text: '正在读取本机凭据…', kind: '' })
        const result = await api('/import-local', { method: 'POST' })
        setOk(`已导入：新增 ${result.added} 个，更新 ${result.updated} 个`)
        await refresh()
      })

      const onExport = () => run('export', async () => {
        const result = await api('/export', { method: 'POST' })
        downloadJson(result.filename, result.document)
        setOk('已生成导出文件。⚠️ 内含明文令牌，请勿外传。')
      })

      const onClear = () => run('clear', async () => {
        if (!window.confirm('确认清空本插件保存的全部账号？此操作不可撤销。')) return
        await api('/clear', { method: 'POST' })
        setOk('已清空')
        await refresh()
      })

      const onPickFile = async (event) => {
        const file = event.target.files?.[0]
        if (!file) return
        const content = await file.text()
        setText(content)
        setOk(`已读取文件：${file.name}`)
        event.target.value = ''
      }

      const onImport = () => run('import', async () => {
        const content = text.trim()
        if (!content) { setErr('请先粘贴内容或选择文件'); return }
        const result = await api('/import', { method: 'POST', body: content })
        setOk(`导入成功：新增 ${result.added} 个，更新 ${result.updated} 个`)
        setText('')
        await refresh()
      })

      const onQuery = () => run('query', async () => {
        setStatus({ text: '正在查询…', kind: '' })
        const info = await api('/download-info')
        setOk(`官方最新版 ${info.version}（${info.platform}）\n${info.url}`)
      })

      const onRefreshCatalog = () => run('catalog', async () => {
        setStatus({ text: '正在刷新模型目录…', kind: '' })
        const result = await api('/refresh-catalog', { method: 'POST' })
        const detail = (result.results ?? [])
          .map((r) => `${r.label}：${r.count} 个${r.error ? `（${r.error}）` : ''}`)
          .join('；')
        if (result.ok) setOk(`模型目录已刷新，共 ${result.total} 个。${detail}`)
        else setErr(`刷新失败：${result.error ?? detail}`)
        await refresh()
      })

      if (state.loading) {
        return h('div', { className: 'wbfn' }, h('div', { className: 'wbfn__hint' }, '正在加载…'))
      }

      return h('div', { className: 'wbfn' },
        // ── 账号列表 ──
        h('div', { className: 'wbfn__title' }, '已接入账号'),
        accounts.length === 0
          ? h('div', { className: 'wbfn__empty' }, '尚未导入任何账号。')
          : accounts.map((account) => {
              const isGlobal = account.variant === 'global'
              const lines = []
              lines.push(`账号：${account.nickname || account.uid || '(未命名)'}`)
              lines.push(`域名：${account.domain || '(未知)'}`)
              if (account.expiresAt) {
                const days = Math.ceil((account.expiresAt - Date.now()) / 86400000)
                const when = new Date(account.expiresAt).toLocaleDateString()
                lines.push(days > 0 ? `到期：${when}（${days} 天后）` : `到期：${when}（已过期）`)
              }
              return h('div', {
                key: `${account.domain}::${account.uid}`,
                className: `wbfn__card ${isGlobal ? 'wbfn__card--global' : 'wbfn__card--cn'}`,
              },
                h('div', { className: 'wbfn__title' }, isGlobal ? 'WorkBuddy（国际版）' : 'CodeBuddy（国内版）'),
                h('div', { className: 'wbfn__meta' }, lines.join('　·　')),
              )
            }),

        // ── 操作 ──
        h('div', { className: 'wbfn__row' },
          data?.hasBinary
            ? h('button', {
                className: 'wbfn__btn wbfn__btn--primary',
                disabled: Boolean(busy),
                onClick: onReadLocal,
              }, busy === 'local' ? '读取中…' : '从本机读取凭据')
            : null,
          accounts.length > 0
            ? h('button', { className: 'wbfn__btn', disabled: Boolean(busy), onClick: onExport }, '导出凭据')
            : null,
          accounts.length > 0
            ? h('button', {
                className: 'wbfn__btn',
                disabled: Boolean(busy),
                onClick: onRefreshCatalog,
                title: '重新从上游拉取模型列表（含倍率与促销标签）',
              }, busy === 'catalog' ? '刷新中…' : '刷新模型目录')
            : null,
          accounts.length > 0
            ? h('button', { className: 'wbfn__btn wbfn__btn--danger', disabled: Boolean(busy), onClick: onClear }, '清空全部账号')
            : null,
        ),

        // ── 导入 ──
        h('div', { className: 'wbfn__title' }, '导入凭据'),
        h('div', { className: 'wbfn__hint' },
          '在装有 WorkBuddy 的电脑上点「导出凭据」，把得到的 JSON 粘贴到下面，或直接选择文件。'),
        h('textarea', {
          className: 'wbfn__textarea',
          placeholder: '把 workbuddy-export.json 的内容粘贴到这里…',
          value: text,
          onChange: (event) => setText(event.target.value),
        }),
        h('div', { className: 'wbfn__row' },
          h('label', { className: 'wbfn__btn' },
            '选择文件…',
            h('input', {
              type: 'file',
              accept: '.json,application/json',
              style: { display: 'none' },
              onChange: onPickFile,
            }),
          ),
          h('button', {
            className: 'wbfn__btn wbfn__btn--primary',
            disabled: Boolean(busy),
            onClick: onImport,
          }, busy === 'import' ? '导入中…' : '导入'),
        ),

        // ── 安全提示 ──
        h('div', { className: 'wbfn__warn' },
          '⚠️ 导出的文件包含明文访问令牌。任何拿到它的人都能使用你的 WorkBuddy 额度。' +
          '请只在自己的设备间传输，不要发送给他人或上传到网盘、聊天群、代码仓库。'),

        // ── 无二进制引导 ──
        data?.hasBinary ? null : h('div', { className: 'wbfn__card' },
          h('div', { className: 'wbfn__title' }, '没有检测到 WorkBuddy'),
          h('div', { className: 'wbfn__hint' },
            '当前机器上没有 WorkBuddy 客户端，无法直接读取凭据。你可以用另一台电脑导出后导入。'),
          h('div', { className: 'wbfn__row' },
            h('button', { className: 'wbfn__btn', disabled: Boolean(busy), onClick: onQuery },
              busy === 'query' ? '查询中…' : '查询官方 Linux 包'),
          ),
        ),

        // ── 状态 ──
        h('div', { className: `wbfn__status${status.kind === 'ok' ? ' wbfn__status--ok' : status.kind === 'err' ? ' wbfn__status--err' : ''}` },
          status.text),
      )
    }

    // ── 插件入口 ──
    function apply(ctx) {
      ensureStyle()

      ctx.effect?.(
        () => ctx.locale?.register(NS, { zh: DICT.zh, en: DICT.en }),
        'workbuddy-fnos: dictionaries',
      )

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'workbuddy-fnos',
        order: 46,
        label: () => 'WorkBuddy 接入',
        locale: NS,
      }, () => h(SettingsPage, {})))
    }

    module.exports = { apply, inject, name: 'workbuddy-fnos' }
    return module.exports
  },
})
