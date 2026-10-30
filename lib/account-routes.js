/**
 * 账号管理的 HTTP 路由
 *
 * 提供四个端点，供设置页调用：
 *   GET  /plugins/dsh-workbuddy-fnos/accounts          列出账号与激活状态
 *   POST /plugins/dsh-workbuddy-fnos/accounts/activate 切换激活账号
 *   POST /plugins/dsh-workbuddy-fnos/accounts/remove   删除账号
 *   GET  /plugins/dsh-workbuddy-fnos/accounts/export   导出
 *   POST /plugins/dsh-workbuddy-fnos/accounts/import   导入
 *
 * 只做纯数据操作，不碰 connect 的原有逻辑。
 *
 * @module dsh-workbuddy-fnos-wenkbaby/account-routes
 */

import { AccountManager } from './pool-store.js'

/** 路由前缀。 */
export const ACCOUNT_API_PREFIX = '/plugins/dsh-workbuddy-fnos/accounts'

/** 读请求体（上限 1 MB，够放几百个令牌）。 */
function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * 注册全部账号管理路由。
 *
 * @param {object} ctx cordis 上下文（需 webServer）
 * @param {object} [options]
 * @param {() => void} [options.onChange] 账号变化后的回调（用于刷新模型目录）
 */
export function registerAccountRoutes(ctx, options = {}) {
  const onChange = options.onChange ?? (() => {})

  const register = (path, handler, label) => {
    ctx.effect(() => {
      const dispose = ctx.webServer.register({
        kind: 'exact',
        path,
        handler,
      })
      return () => dispose()
    }, `dsh-workbuddy-fnos: ${label}`)
  }

  // 列出账号
  register(ACCOUNT_API_PREFIX, (req, res) => {
    try {
      const data = AccountManager.list()
      sendJson(res, 200, { ok: true, ...data })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
  }, 'accounts list')

  // 切换激活
  register(`${ACCOUNT_API_PREFIX}/activate`, async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    try {
      const body = JSON.parse(await readBody(req))
      const result = AccountManager.activate(body.variant, body.uid)
      if (result.ok) onChange()
      sendJson(res, result.ok ? 200 : 400, result)
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
    }
  }, 'accounts activate')

  // 删除账号
  register(`${ACCOUNT_API_PREFIX}/remove`, async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    try {
      const body = JSON.parse(await readBody(req))
      const result = AccountManager.remove(body.variant, body.uid)
      if (result.ok) onChange()
      sendJson(res, result.ok ? 200 : 400, result)
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
    }
  }, 'accounts remove')

  // 导出
  register(`${ACCOUNT_API_PREFIX}/export`, (req, res) => {
    if (req.method !== 'GET' && req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    try {
      const doc = AccountManager.export()
      sendJson(res, 200, {
        ok: true,
        filename: 'workbuddy-export.json',
        warning: doc.warning,
        document: doc,
      })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
  }, 'accounts export')

  // 导入
  register(`${ACCOUNT_API_PREFIX}/import`, async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    try {
      const text = await readBody(req)
      const result = AccountManager.import(text)
      if (result.ok) onChange()
      sendJson(res, result.ok ? 200 : 400, result)
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
    }
  }, 'accounts import')
}
