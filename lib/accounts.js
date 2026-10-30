/**
 * 多账号池存储
 *
 * dsh-workbuddy-connect 原本每个版本（cn / ai）只保存一个凭据，文件名固定。
 * 本模块在同一位置维护一个可容纳多个账号的池，并按版本记录「当前激活」。
 *
 * 存储形状（$DSH_HOME/workbuddy-accounts.json）：
 *   {
 *     "version": 1,
 *     "active": { "cn": "<uid>", "ai": "<uid>" },
 *     "accounts": [
 *       { "variant": "cn", "uid": "...", "credential": { ... } },
 *       ...
 *     ]
 *   }
 *
 * 兼容性：
 *   - 首次读取时，若池文件不存在但旧的单账号文件存在，自动迁移过来并把
 *     旧账号设为该版本的激活账号。
 *   - 旧文件保留不删，便于回退。
 *
 * @module dsh-workbuddy-fnos-wenkbaby/accounts
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** 池文件格式版本。 */
const POOL_VERSION = 1

/** 池文件名。 */
const POOL_FILENAME = 'workbuddy-accounts.json'

/** 各版本对应的旧单账号文件名。 */
const LEGACY_FILENAMES = {
  cn: 'workbuddy-auth.json',
  ai: 'workbuddy-ai-auth.json',
}

/** 解析 DSH home。 */
function resolveHome() {
  const env = process.env.DSH_HOME
  if (env && env.trim()) return env.trim()
  const home = process.env.HOME || process.env.USERPROFILE || '.'
  return path.join(home, '.dsh')
}

/** 池文件绝对路径。 */
export function poolPath() {
  return path.join(resolveHome(), POOL_FILENAME)
}

/** 旧单账号文件路径。 */
export function legacyPath(variant) {
  const name = LEGACY_FILENAMES[variant]
  return name ? path.join(resolveHome(), name) : undefined
}

/** 空池。 */
function emptyPool() {
  return { version: POOL_VERSION, active: {}, accounts: [] }
}

/** 把任意形状的文档规整成池；不认识的内容返回空池。 */
function normalize(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyPool()
  if (value.version !== POOL_VERSION) return emptyPool()

  const accounts = []
  const list = Array.isArray(value.accounts) ? value.accounts : []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const variant = item.variant === 'ai' ? 'ai' : item.variant === 'cn' ? 'cn' : undefined
    if (!variant) continue
    const cred = item.credential
    if (!cred || typeof cred !== 'object') continue
    if (typeof cred.accessToken !== 'string' || cred.accessToken === '') continue
    accounts.push({
      variant,
      uid: typeof item.uid === 'string' ? item.uid : typeof cred.uid === 'string' ? cred.uid : '',
      credential: cred,
    })
  }

  const active = {}
  if (value.active && typeof value.active === 'object') {
    for (const v of ['cn', 'ai']) {
      const uid = value.active[v]
      if (typeof uid === 'string' && accounts.some((a) => a.variant === v && a.uid === uid)) {
        active[v] = uid
      }
    }
  }

  // 每个版本若没有有效激活账号，自动选第一个
  for (const v of ['cn', 'ai']) {
    if (active[v]) continue
    const first = accounts.find((a) => a.variant === v)
    if (first) active[v] = first.uid
  }

  return { version: POOL_VERSION, active, accounts }
}

/** 读池文件。 */
function readPoolFile() {
  const file = poolPath()
  if (!existsSync(file)) return undefined
  try {
    return normalize(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return undefined
  }
}

/**
 * 从旧单账号文件迁移。
 * 只处理 `{version, credential}` 这种形状。
 */
function readLegacy(variant) {
  const file = legacyPath(variant)
  if (!file || !existsSync(file)) return undefined
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    const cred = doc?.credential
    if (!cred || typeof cred.accessToken !== 'string' || cred.accessToken === '') return undefined
    return { variant, uid: typeof cred.uid === 'string' ? cred.uid : '', credential: cred }
  } catch {
    return undefined
  }
}

/**
 * 读取池，必要时做一次旧文件迁移。
 * @returns {{version:number, active:object, accounts:Array}}
 */
export function loadPool() {
  const existing = readPoolFile()
  if (existing) return existing

  // 池不存在：尝试从旧文件建池
  const migrated = []
  const active = {}
  for (const variant of ['cn', 'ai']) {
    const legacy = readLegacy(variant)
    if (legacy) {
      migrated.push(legacy)
      active[variant] = legacy.uid
    }
  }
  if (migrated.length === 0) return emptyPool()

  const pool = { version: POOL_VERSION, active, accounts: migrated }
  try {
    writePool(pool)
  } catch {
    // 迁移写入失败不影响本次使用
  }
  return pool
}

/** 原子写入池。 */
export function writePool(pool) {
  const file = poolPath()
  const dir = path.dirname(file)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(pool, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
  try {
    chmodSync(file, 0o600)
  } catch {
    // Windows 上忽略
  }
  return file
}

/** 某版本的账号列表。 */
export function accountsOf(pool, variant) {
  return pool.accounts.filter((a) => a.variant === variant)
}

/** 某版本当前激活的账号。 */
export function activeOf(pool, variant) {
  const uid = pool.active[variant]
  if (!uid) return undefined
  return pool.accounts.find((a) => a.variant === variant && a.uid === uid)
}

/**
 * 加入或更新一个账号。
 * @param {{version:number, active:object, accounts:Array}} pool
 * @param {'cn'|'ai'} variant
 * @param {object} credential
 * @param {boolean} [makeActive] 是否设为激活
 * @returns {{added:boolean, pool:object}}
 */
export function upsertAccount(pool, variant, credential, makeActive = true) {
  const uid = typeof credential.uid === 'string' ? credential.uid : ''
  const key = uid || credential.nickname || credential.accessToken.slice(0, 16)

  const idx = pool.accounts.findIndex((a) => {
    if (a.variant !== variant) return false
    const aKey = a.uid || a.credential.nickname || a.credential.accessToken.slice(0, 16)
    return aKey === key
  })

  const entry = { variant, uid, credential }
  let added = false
  if (idx >= 0) {
    pool.accounts[idx] = entry
  } else {
    pool.accounts.push(entry)
    added = true
  }

  if (makeActive) pool.active[variant] = uid
  else if (!pool.active[variant]) pool.active[variant] = uid

  return { added, pool }
}

/** 切换某版本的激活账号。 */
export function setActive(pool, variant, uid) {
  const found = pool.accounts.find((a) => a.variant === variant && a.uid === uid)
  if (!found) return false
  pool.active[variant] = uid
  return true
}

/** 删除一个账号。 */
export function removeAccount(pool, variant, uid) {
  const before = pool.accounts.length
  pool.accounts = pool.accounts.filter((a) => !(a.variant === variant && a.uid === uid))
  const removed = pool.accounts.length !== before

  if (removed && pool.active[variant] === uid) {
    const next = pool.accounts.find((a) => a.variant === variant)
    if (next) pool.active[variant] = next.uid
    else delete pool.active[variant]
  }
  return removed
}

/** 导出：把池转换成带元信息的可分发文档。 */
export function buildExport(pool) {
  return {
    schema: 'dsh-workbuddy-export/v1',
    exportedAt: new Date().toISOString(),
    warning: '此文件包含明文访问令牌，请勿分享或上传到公共位置。',
    accounts: pool.accounts.map((a) => ({
      variant: a.variant,
      uid: a.uid,
      nickname: typeof a.credential.nickname === 'string' ? a.credential.nickname : '',
      domain: typeof a.credential.domain === 'string' ? a.credential.domain : '',
      credential: a.credential,
    })),
  }
}

/**
 * 解析导入文档。
 * 接受本插件导出的格式，也接受裸的 `{accounts:[...]}` 或单个 credential。
 * @returns {{entries:Array<{variant:string,credential:object}>, error?:string}}
 */
export function parseImport(text) {
  let doc
  try {
    doc = JSON.parse(text)
  } catch {
    return { entries: [], error: '不是合法的 JSON' }
  }

  const entries = []

  const push = (variant, credential) => {
    if (!credential || typeof credential !== 'object') return
    if (typeof credential.accessToken !== 'string' || credential.accessToken === '') return
    const v = variant === 'ai' ? 'ai' : variant === 'cn' ? 'cn' : undefined
    if (!v) return
    entries.push({ variant: v, credential })
  }

  if (Array.isArray(doc?.accounts)) {
    for (const item of doc.accounts) {
      if (!item || typeof item !== 'object') continue
      push(item.variant, item.credential)
    }
  } else if (doc?.credential && typeof doc.credential === 'object') {
    // 单个 credential 文档（老的 own 文件）
    const domain = typeof doc.credential.domain === 'string' ? doc.credential.domain : ''
    const variant = /workbuddy\.ai$/i.test(domain) ? 'ai' : 'cn'
    push(variant, doc.credential)
  } else if (doc?.auth && typeof doc.auth === 'object' && typeof doc.auth.accessToken === 'string') {
    // WorkBuddy 桌面 auth.info 的明文形状
    const domain = typeof doc.auth.domain === 'string' ? doc.auth.domain : ''
    const variant = /workbuddy\.ai$/i.test(domain) ? 'ai' : 'cn'
    const account = doc.account && typeof doc.account === 'object' ? doc.account : {}
    push(variant, {
      accessToken: doc.auth.accessToken,
      refreshToken: typeof doc.auth.refreshToken === 'string' ? doc.auth.refreshToken : '',
      expiresAtMs: typeof doc.auth.expiresAt === 'number' ? doc.auth.expiresAt : 0,
      domain,
      uid: typeof account.uid === 'string' ? account.uid : '',
      nickname: typeof account.nickname === 'string' ? account.nickname : '',
      enterpriseId: typeof account.enterpriseId === 'string' ? account.enterpriseId : '',
    })
  }

  if (entries.length === 0) {
    return { entries: [], error: '没有找到可导入的账号（缺少 accessToken）' }
  }
  return { entries }
}
