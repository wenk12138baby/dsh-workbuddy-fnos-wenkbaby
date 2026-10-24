/**
 * dsh-workbuddy-fnos-wenkbaby —— 插件入口（Host 半身）
 *
 * 职责：
 *   1. 启动时读取已保存的账号；若检测到本机 WorkBuddy 且尚无账号，自动解密导入
 *   2. 向 DSH 内核注册 LLM adapter，让模型出现在选择器里
 *   3. 挂载设置页 API（导出 / 导入 / 下载官方包 / 账号管理）
 *
 * 设计原则：
 *   - 不修改任何系统文件；二进制只解包到插件私有目录
 *   - 凭据只落在 DSH home 下的 0600 文件
 *   - 任何日志都不打印 token
 *
 * @module dsh-workbuddy-fnos-wenkbaby
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { WorkBuddyAdapter, ROUTE_CN, ROUTE_GLOBAL } from './adapter.js'
import { deriveProtectorKey, extractAccount, variantOf } from './crypto.js'
import {
  buildExport,
  loadAccounts,
  mergeAccounts,
  parseImport,
  saveAccounts,
  storeDir,
  storePath,
} from './store.js'
import {
  findBinary,
  linuxDownloadPlatform,
  queryLinuxDownload,
  readAtRestSecretKey,
} from './upstream.js'

/** 插件名（Cordis 用）。 */
export const name = 'workbuddy-fnos'

/** 依赖的服务：llm 用于注册 adapter，webServer 用于设置页 API。 */
export const inject = ['llm']

/** 配置（暂无可调项）。 */
export const Config = undefined

/** 已保存账号的内存镜像。 */
let accounts = []

/** adapter 实例（供设置页刷新用）。 */
let adapter = null

/** 启动日志（不含敏感信息）。 */
function log(ctx, message) {
  try {
    ctx?.logger?.info?.(`[workbuddy-fnos] ${message}`)
  } catch {
    // 日志失败不影响主流程
  }
}

/** 本机 WorkBuddy 凭据目录候选。 */
function localAuthDirs() {
  const home = os.homedir()
  const dirs = []
  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) {
      dirs.push(path.join(process.env.LOCALAPPDATA, 'CodeBuddyExtension', 'Data', 'Public', 'auth'))
    }
    if (process.env.APPDATA) {
      dirs.push(path.join(process.env.APPDATA, 'CodeBuddyExtension', 'Data', 'Public', 'auth'))
    }
  } else if (process.platform === 'darwin') {
    dirs.push(path.join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth'))
  } else {
    dirs.push(path.join(home, '.local', 'share', 'CodeBuddyExtension', 'Data', 'Public', 'auth'))
  }
  return dirs
}

/**
 * 枚举本机 auth.info 文件。
 * @returns {Array<{ file: string, doc: object }>}
 */
function localAuthDocs() {
  const found = []
  for (const dir of localAuthDirs()) {
    if (!existsSync(dir)) continue
    let entries
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.endsWith('.info')) continue
      const full = path.join(dir, entry)
      try {
        const doc = JSON.parse(readFileSync(full, 'utf8'))
        if (doc?.auth) found.push({ file: full, doc })
      } catch {
        // 不是 JSON 或不可读，跳过
      }
    }
  }
  return found
}

/**
 * 尝试从本机 WorkBuddy 直接读取并解密凭据。
 * 只有本机存在 WorkBuddy 二进制与 auth.info 时才可能成功。
 *
 * @returns {Promise<Array<object>>} 解出的账号（可能为空）
 */
async function readLocalAccounts() {
  const binary = findBinary()
  if (!binary) return []

  const docs = localAuthDocs()
  if (docs.length === 0) return []

  let secret
  try {
    secret = await readAtRestSecretKey(binary)
  } catch {
    return []
  }

  const { key, keyId } = deriveProtectorKey(secret)
  const out = []
  for (const { doc } of docs) {
    const account = extractAccount(doc, key, keyId)
    if (account && account.accessToken) out.push(account)
  }
  return out
}

/** JSON 响应助手。 */
function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** 读取请求体（限制 1MB）。 */
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

/** 设置页 API 前缀。 */
const API_PREFIX = '/api/workbuddy-fnos'

/**
 * 设置页 API。
 * 所有路由都走同一前缀，由 fnOS / DSH 的信任围栏保护。
 */
function apiHandler(ctx) {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const route = url.pathname.slice(API_PREFIX.length) || '/'

    try {
      // ── 状态 ──
      if (route === '/status' && req.method === 'GET') {
        const binary = findBinary()
        const docs = localAuthDocs()
        return json(res, 200, {
          accounts: accounts.map((a) => ({
            domain: a.domain,
            uid: a.uid,
            nickname: a.nickname,
            variant: variantOf(a.domain),
            expiresAt: a.expiresAt,
            hasRefresh: Boolean(a.refreshToken),
          })),
          binary: binary ? path.basename(binary) : '',
          hasBinary: Boolean(binary),
          localAuthCount: docs.length,
          platform: process.platform,
          arch: process.arch,
          storePath: storePath(),
        })
      }

      // ── 从本机读取（PC 端一键导入）──
      if (route === '/import-local' && req.method === 'POST') {
        const found = await readLocalAccounts()
        if (found.length === 0) {
          return json(res, 400, {
            ok: false,
            error: '未能读取本机凭据。请确认已安装并登录 WorkBuddy 桌面端。',
          })
        }
        const { merged, added, updated } = mergeAccounts(accounts, found)
        accounts = merged
        saveAccounts(accounts)
        adapter?.refresh?.()
        return json(res, 200, { ok: true, added, updated, total: accounts.length })
      }

      // ── 导出 ──
      if (route === '/export' && req.method === 'POST') {
        if (accounts.length === 0) {
          return json(res, 400, { ok: false, error: '当前没有可导出的账号。' })
        }
        return json(res, 200, {
          ok: true,
          filename: 'workbuddy-export.json',
          warning: '此文件包含明文访问令牌，请勿分享或上传到公共位置。',
          document: buildExport(accounts),
        })
      }

      // ── 导入 ──
      if (route === '/import' && req.method === 'POST') {
        const text = await readBody(req)
        const { accounts: incoming, error } = parseImport(text)
        if (error) return json(res, 400, { ok: false, error })

        const { merged, added, updated } = mergeAccounts(accounts, incoming)
        accounts = merged
        saveAccounts(accounts)
        return json(res, 200, { ok: true, added, updated, total: accounts.length })
      }

      // ── 删除某个账号 ──
      if (route === '/remove' && req.method === 'POST') {
        const text = await readBody(req)
        let payload
        try {
          payload = JSON.parse(text)
        } catch {
          return json(res, 400, { ok: false, error: '请求体不是 JSON' })
        }
        const { domain, uid } = payload ?? {}
        accounts = accounts.filter((a) => !(a.domain === domain && a.uid === uid))
        saveAccounts(accounts)
        return json(res, 200, { ok: true, total: accounts.length })
      }

      // ── 查询官方 Linux 包 ──
      if (route === '/download-info' && req.method === 'GET') {
        const platform = linuxDownloadPlatform()
        const info = await queryLinuxDownload(platform)
        return json(res, 200, { ok: true, platform, ...info })
      }

      // ── 刷新模型目录（清缓存后重新拉上游）──
      if (route === '/refresh-catalog' && req.method === 'POST') {
        if (!adapter) return json(res, 503, { ok: false, error: 'adapter 尚未就绪' })

        const results = []
        for (const provider of [ROUTE_GLOBAL, ROUTE_CN]) {
          const label = adapter.providerInfo(provider).name
          // 没有账号的路由不拉远程，直接报数量
          const accounts = adapter.accountsFor(provider)
          if (accounts.length === 0) {
            results.push({ provider, label, count: 0, source: 'none', error: '没有可用账号' })
            continue
          }
          try {
            const info = await adapter.refreshCatalog(provider)
            results.push({ provider, label, ...info })
          } catch (error) {
            results.push({
              provider,
              label,
              count: 0,
              source: 'fallback',
              error: String(error?.message ?? error),
            })
          }
        }

        const total = results.reduce((sum, r) => sum + (r.count ?? 0), 0)
        const failed = results.filter((r) => r.error)
        return json(res, 200, {
          ok: failed.length < results.length,
          total,
          results,
          error: failed.length === results.length ? (failed[0]?.error ?? '刷新失败') : undefined,
        })
      }

      // ── 清除全部账号 ──
      if (route === '/clear' && req.method === 'POST') {
        accounts = []
        saveAccounts(accounts)
        return json(res, 200, { ok: true })
      }

      return json(res, 404, { ok: false, error: 'not found' })
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
  }
}

/**
 * 插件主体。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  // 1) 载入已保存账号
  accounts = loadAccounts()
  log(ctx, `已载入 ${accounts.length} 个账号`)

  // 2) 注册 adapter
  adapter = new WorkBuddyAdapter({ getAccounts: () => accounts })
  let registration
  try {
    registration = ctx.llm.registerAdapter([ROUTE_GLOBAL, ROUTE_CN], adapter)
    log(ctx, 'LLM adapter 已注册（workbuddy / codebuddy）')
  } catch (error) {
    log(ctx, `adapter 注册失败：${error?.message ?? error}`)
  }
  ctx.effect?.(() => () => {
    try { registration?.() } catch { /* 释放失败忽略 */ }
  }, 'workbuddy-fnos: adapter')

  // 3) 挂载设置页 API
  ctx.inject?.([ 'webServer' ], (webCtx) => {
    const server = webCtx.webServer
    if (!server?.register) return
    webCtx.effect?.(() => server.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: apiHandler(ctx),
    }), 'workbuddy-fnos: api routes')
    log(ctx, `设置页 API 已挂载：${API_PREFIX}`)
  })

  // 4) 首次启动尝试自动读取本机凭据（PC 端零操作）
  if (accounts.length === 0) {
    void readLocalAccounts().then((found) => {
      if (found.length === 0) return
      const { merged } = mergeAccounts(accounts, found)
      accounts = merged
      saveAccounts(accounts)
      log(ctx, `已从本机 WorkBuddy 自动导入 ${found.length} 个账号`)
    }).catch((error) => {
      log(ctx, `自动读取本机凭据失败：${error?.message ?? error}`)
    })
  }
}
