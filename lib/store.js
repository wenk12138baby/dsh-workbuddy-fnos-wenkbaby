/**
 * 凭据存储与导入导出
 *
 * 安全约束：
 *   - 凭据只落在 DSH home 下的私有目录，文件权限 0600
 *   - 导出文件含明文 token，导出时反复提醒不要外泄
 *   - 任何日志都不打印 token
 *
 * @module dsh-workbuddy-fnos-wenkbaby/store
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** 导出文件格式标识。 */
export const EXPORT_SCHEMA = 'dsh-workbuddy-export/v1'

/** 存储文件名。 */
const STORE_FILE = 'accounts.json'

/** 解析 DSH home：优先环境变量，其次 ~/.dsh。 */
export function resolveHome() {
  const env = process.env.DSH_HOME
  if (env && env.trim()) return env
  const home = process.env.HOME || process.env.USERPROFILE || '.'
  return path.join(home, '.dsh')
}

/** 插件私有目录。 */
export function storeDir() {
  return path.join(resolveHome(), 'workbuddy-fnos')
}

/** 凭据文件绝对路径。 */
export function storePath() {
  return path.join(storeDir(), STORE_FILE)
}

/** 读取已保存的账号列表；不存在或损坏时返回空数组。 */
export function loadAccounts() {
  try {
    const raw = readFileSync(storePath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed?.accounts)) return []
    return parsed.accounts.filter(
      (a) => a && typeof a.accessToken === 'string' && a.accessToken.length > 0,
    )
  } catch {
    return []
  }
}

/**
 * 保存账号列表（原子写 + 0600）。
 * @param {Array<object>} accounts
 */
export function saveAccounts(accounts) {
  const dir = storeDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })

  const doc = {
    schema: EXPORT_SCHEMA,
    savedAt: new Date().toISOString(),
    accounts,
  }
  const target = storePath()
  const tmp = `${target}.tmp`
  writeFileSync(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 })
  try { chmodSync(tmp, 0o600) } catch { /* Windows 上无意义 */ }
  // 覆盖写入
  writeFileSync(target, readFileSync(tmp))
  try { rmSync(tmp, { force: true }) } catch { /* 忽略 */ }
  try { chmodSync(target, 0o600) } catch { /* 忽略 */ }
  return target
}

/** 账号唯一键：同一 domain 下按 uid 区分。 */
export function accountKey(account) {
  return `${account.domain || 'unknown'}::${account.uid || account.nickname || 'anon'}`
}

/**
 * 合并导入的账号：同 key 覆盖，其余保留。
 * @param {Array<object>} existing
 * @param {Array<object>} incoming
 * @returns {{ merged: Array<object>, added: number, updated: number }}
 */
export function mergeAccounts(existing, incoming) {
  const map = new Map(existing.map((a) => [accountKey(a), a]))
  let added = 0
  let updated = 0
  for (const account of incoming) {
    const key = accountKey(account)
    if (map.has(key)) updated += 1
    else added += 1
    map.set(key, account)
  }
  return { merged: [...map.values()], added, updated }
}

/**
 * 校验并规范化一条导入的账号记录。
 * @returns {object|null} 非法时返回 null
 */
export function normalizeAccount(raw) {
  if (!raw || typeof raw !== 'object') return null
  const accessToken = typeof raw.accessToken === 'string' ? raw.accessToken.trim() : ''
  if (accessToken.length < 20) return null

  const domain = typeof raw.domain === 'string' ? raw.domain.trim() : ''
  return {
    domain,
    uid: typeof raw.uid === 'string' ? raw.uid.trim() : '',
    nickname: typeof raw.nickname === 'string' ? raw.nickname.trim() : '',
    enterpriseId: typeof raw.enterpriseId === 'string' ? raw.enterpriseId.trim() : '',
    accessToken,
    refreshToken: typeof raw.refreshToken === 'string' ? raw.refreshToken.trim() : '',
    expiresAt: typeof raw.expiresAt === 'number' ? raw.expiresAt : 0,
  }
}

/**
 * 解析导入文件内容。
 * 支持两种形状：
 *   - { schema, accounts: [...] }   本插件导出格式
 *   - { accounts: [...] } / [...]    宽松兼容
 *
 * @param {string} text
 * @returns {{ accounts: Array<object>, error?: string }}
 */
export function parseImport(text) {
  let doc
  try {
    doc = JSON.parse(text)
  } catch {
    return { accounts: [], error: '不是合法的 JSON' }
  }

  const list = Array.isArray(doc) ? doc : Array.isArray(doc?.accounts) ? doc.accounts : []
  if (list.length === 0) return { accounts: [], error: '文件中没有找到账号（accounts 为空）' }

  const accounts = []
  for (const item of list) {
    const normalized = normalizeAccount(item)
    if (normalized) accounts.push(normalized)
  }
  if (accounts.length === 0) return { accounts: [], error: '账号记录缺少有效的 accessToken' }
  return { accounts }
}

/** 生成导出文档。 */
export function buildExport(accounts) {
  return {
    schema: EXPORT_SCHEMA,
    exportedAt: new Date().toISOString(),
    warning: '此文件包含明文访问令牌，请勿分享或上传到任何公共位置。',
    accounts,
  }
}
