/**
 * 模型目录
 *
 * 上游的模型列表来自 `/v3/config`（不是 /v1/models），返回体里
 * `data.models` 是模型数组，每项含 id / name / maxInputTokens / maxOutputTokens。
 *
 * 官方客户端的默认模型是 `auto`（isDefault: true），不是某个具名模型。
 *
 * @module dsh-workbuddy-fnos-wenkbaby/catalog
 */

import { buildChatHeaders, chatBase } from './upstream.js'

/** 目录缓存时长：10 分钟。 */
const CACHE_TTL_MS = 10 * 60 * 1000

/** 拉取超时。 */
const FETCH_TIMEOUT_MS = 15000

/**
 * 兜底目录：网络不可用或未登录时使用。
 * 取自 2026-10-24 实测的国内版 /v3/config，按官方顺序排列。
 */
export const FALLBACK_CN = [
  { id: 'auto', name: 'Auto', contextWindow: 168000, maxOutputTokens: 32000 },
  { id: 'hy3', name: 'Hy3', contextWindow: 192000, maxOutputTokens: 64000 },
  { id: 'minimax-m2.5', name: 'MiniMax-M2.5', contextWindow: 200000, maxOutputTokens: 48000 },
  { id: 'glm-5v-turbo', name: 'GLM-5v-Turbo', contextWindow: 200000, maxOutputTokens: 38000 },
  { id: 'glm-5.1', name: 'GLM-5.1', contextWindow: 200000, maxOutputTokens: 48000 },
  { id: 'glm-5.0-turbo', name: 'GLM-5.0-Turbo', contextWindow: 200000, maxOutputTokens: 48000 },
  { id: 'glm-5.0', name: 'GLM-5.0', contextWindow: 200000, maxOutputTokens: 48000 },
  { id: 'glm-4.7', name: 'GLM-4.7', contextWindow: 200000, maxOutputTokens: 48000 },
  { id: 'glm-4.6v', name: 'GLM-4.6V', contextWindow: 128000, maxOutputTokens: 32000 },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 256000, maxOutputTokens: 32000 },
  { id: 'kimi-k2.5', name: 'Kimi-K2.5', contextWindow: 256000, maxOutputTokens: 32000 },
  { id: 'kimi-k2-thinking', name: 'Kimi-K2-Thinking', contextWindow: 256000, maxOutputTokens: 32000 },
  { id: 'minimax-m2.7', name: 'MiniMax-M2.7', contextWindow: 200000, maxOutputTokens: 48000 },
  { id: 'glm-4.6', name: 'GLM-4.6', contextWindow: 168000, maxOutputTokens: 32000 },
  { id: 'deepseek-v4-flash', name: 'Deepseek-V4-Flash', contextWindow: 1000000, maxOutputTokens: 50000 },
  { id: 'deepseek-v3-2-volc', name: 'DeepSeek-V3.2', contextWindow: 96000, maxOutputTokens: 32000 },
  { id: 'deepseek-v3-1-volc', name: 'DeepSeek-V3-1-Terminus', contextWindow: 96000, maxOutputTokens: 32000 },
  { id: 'deepseek-v3-1-lkeap', name: 'DeepSeek-V3-1', contextWindow: 96000, maxOutputTokens: 32000 },
  { id: 'deepseek-v3-1', name: 'DeepSeek-V3.1', contextWindow: 96000, maxOutputTokens: 32000 },
  { id: 'deepseek-v3-0324-lkeap', name: 'DeepSeek-V3-0324', contextWindow: 112000, maxOutputTokens: 16000 },
  { id: 'deepseek-r1-0528-lkeap', name: 'DeepSeek-R1-0528', contextWindow: 96000, maxOutputTokens: 16000 },
  { id: 'default-1.1', name: 'Claude-3.7-Sonnet', contextWindow: 200000, maxOutputTokens: 8192 },
  { id: 'default-1.2', name: 'Claude-4.0-Sonnet', contextWindow: 200000, maxOutputTokens: 24000 },
  { id: 'hunyuan-2.0-instruct', name: 'Hunyuan-2.0-Instruct', contextWindow: 128000, maxOutputTokens: 16000 },
  { id: 'hunyuan-chat', name: 'Hunyuan-Turbos', contextWindow: 128000, maxOutputTokens: 8192 },
]

/** 兜底目录：国际版（结构与国内版一致，模型集可能不同）。 */
export const FALLBACK_GLOBAL = FALLBACK_CN

/** 把上游模型条目规范化成内核要的形状。 */
function normalizeModel(entry, provider) {
  const id = typeof entry?.id === 'string' ? entry.id : ''
  if (!id) return null
  const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name : id
  const ctx = Number(entry.maxInputTokens) || Number(entry.maxAllowedSize) || 0
  const out = Number(entry.maxOutputTokens) || 0
  return {
    provider,
    id,
    name,
    ...(ctx > 0 ? { contextWindow: ctx } : {}),
    ...(out > 0 ? { maxOutputTokens: out } : {}),
  }
}

// ── 计费标注 ────────────────────────────────────────────────

/** badge 标签前缀，来自上游 console catalog 的 tags 数组。 */
const BADGE_PREFIX = 'badge:'

/** 名称与标注之间的分隔符（与官方客户端一致）。 */
const SUFFIX_SEPARATOR = ' · '

/**
 * 规整倍率文本。
 *
 * 上游可能给出 "x0.05"、"x2.20 credits"、"x0.00 credits" 等写法：
 * 去掉尾部的 " credits"，并把 "x" 前缀保留成 "×"（与官方 UI 一致）。
 *
 * @param {string|undefined} credits
 * @returns {string|undefined}
 */
function normalizeCredits(credits) {
  if (typeof credits !== 'string') return undefined
  const trimmed = credits.trim()
  if (trimmed === '') return undefined
  // "credits" 单独出现没有信息量
  if (/^credits?$/i.test(trimmed)) return undefined
  const bare = trimmed.replace(/\s+credits?$/i, '').trim()
  if (bare === '') return undefined
  // x0.05 -> ×0.05
  return bare.replace(/^x/i, '×')
}

/**
 * 判断是否免费：倍率为 0（0.00 / x0.00 都算）。
 * @param {string} bare 去掉 × 后的数字文本
 */
function isZeroRate(bare) {
  return /^0?\.?0+$/.test(bare.replace(/^[x×]/i, '').trim())
}

/**
 * 解析一行的计费信息。
 *
 * 上游 console catalog 里：
 *   credits: "x0.05" | "x2.20 credits" | "x0.00 credits"
 *   tags:    ["craft", "badge:限时免费:#FF0000", "badge:夜间折扣:#1E90FF"]
 *
 * @param {object} entry console catalog 的一行
 * @returns {{ rate?: string, badges: string[], free: boolean }}
 */
function parseBilling(entry) {
  const rawCredits = typeof entry?.credits === 'string' ? entry.credits : ''
  const tags = Array.isArray(entry?.tags) ? entry.tags : []

  const badges = []
  for (const tag of tags) {
    if (typeof tag !== 'string' || !tag.toLowerCase().startsWith(BADGE_PREFIX)) continue
    // "badge:限时免费:#FF0000" -> "限时免费"
    const parts = tag.slice(BADGE_PREFIX.length).split(':')
    const label = (parts[0] ?? '').trim()
    if (label) badges.push(label)
  }

  const rate = normalizeCredits(rawCredits)
  const free = rate !== undefined && isZeroRate(rate)

  return { rate, badges, free }
}

/**
 * 把一个模型的计费信息拼成显示名后缀。
 * @param {object} entry
 * @returns {string|undefined}
 */
function displaySuffix(entry) {
  const { rate, badges, free } = parseBilling(entry)
  const parts = []
  if (free) parts.push('免费')
  else if (rate) parts.push(rate)
  for (const badge of badges) parts.push(badge)
  return parts.length === 0 ? undefined : parts.join(SUFFIX_SEPARATOR)
}

/**
 * 把计费信息合并进模型列表。
 *
 * 只改 `name`（用于显示），`id` 保持原样 —— 请求路由用的是 id，
 * 内核也只校验 name 是非空字符串，不会按名字反查模型。
 *
 * @param {Array<object>} models normalizeModel 产出的列表
 * @param {Array<object>} consoleRows console catalog 的原始行
 * @returns {Array<object>}
 */
function applyBilling(models, consoleRows) {
  if (!Array.isArray(consoleRows) || consoleRows.length === 0) return models

  const byId = new Map()
  for (const row of consoleRows) {
    if (row && typeof row.id === 'string') byId.set(row.id, row)
  }

  return models.map((model) => {
    const row = byId.get(model.id)
    if (!row) return model
    const suffix = displaySuffix(row)
    if (!suffix) return model
    return { ...model, name: `${model.name}${SUFFIX_SEPARATOR}${suffix}` }
  })
}

/**
 * 从 console catalog 拉计费信息。
 *
 * 端点：`/console/enterprises/personal/models`
 * `/v3/config` 只有模型清单，没有 credits / badge 标签，两者需要合并。
 *
 * @param {object} account
 * @param {'global'|'cn'} variant
 * @returns {Promise<Array<object>|undefined>} 失败时返回 undefined（不阻断主流程）
 */
export async function fetchConsoleCatalog(account, variant) {
  const url = `${chatBase(variant)}/console/enterprises/personal/models`
  try {
    const response = await fetch(url, {
      headers: buildChatHeaders(account, variant),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) return undefined
    const doc = await response.json()
    const data = doc?.data ?? doc
    const rows = data?.models
    return Array.isArray(rows) ? rows : undefined
  } catch {
    return undefined
  }
}

/** 每个 variant 的缓存。 */
const cache = new Map()

/**
 * 从上游拉取模型目录。
 *
 * @param {object} account  { accessToken, uid, domain, enterpriseId }
 * @param {'global'|'cn'} variant
 * @returns {Promise<Array<object>>} 失败时抛错
 */
export async function fetchCatalog(account, variant) {
  const url = `${chatBase(variant)}/v3/config`
  const response = await fetch(url, {
    headers: buildChatHeaders(account, variant),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })

  if (!response.ok) {
    throw new Error(`拉取模型目录失败：HTTP ${response.status}`)
  }

  const doc = await response.json()
  // 上游包了一层：{ code, msg, requestId, data: { models: [...] } }
  if (typeof doc?.code === 'number' && doc.code !== 0) {
    throw new Error(`拉取模型目录失败：code ${doc.code} ${doc.msg || ''}`.trim())
  }

  const list = doc?.data?.models ?? doc?.models
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('模型目录为空')
  }

  const provider = variant === 'global' ? 'workbuddy' : 'codebuddy'
  const models = list.map((entry) => normalizeModel(entry, provider)).filter(Boolean)
  if (models.length === 0) throw new Error('模型目录无有效条目')
  return models
}

/**
 * 取模型目录：优先缓存，其次上游，最后兜底。
 *
 * @param {object} account
 * @param {'global'|'cn'} variant
 * @param {object} [options] { force?: boolean }
 * @returns {Promise<{ models: Array<object>, source: 'cache'|'upstream'|'fallback', error?: string }>}
 */
export async function getCatalog(account, variant, options = {}) {
  const now = Date.now()
  const hit = cache.get(variant)
  if (!options.force && hit && now - hit.at < CACHE_TTL_MS) {
    return { models: hit.models, source: 'cache' }
  }

  if (account?.accessToken) {
    try {
      const models = await fetchCatalog(account, variant)
      // 计费标注是显示增强：拉不到也不影响模型可用性
      const consoleRows = await fetchConsoleCatalog(account, variant)
      const enriched = applyBilling(models, consoleRows)
      cache.set(variant, { at: now, models: enriched })
      return { models: enriched, source: 'upstream' }
    } catch (error) {
      // 拉取失败：清缓存并回退，避免用过期数据冒充实时
      cache.delete(variant)
      const fallback = variant === 'global' ? FALLBACK_GLOBAL : FALLBACK_CN
      const provider = variant === 'global' ? 'workbuddy' : 'codebuddy'
      return {
        models: fallback.map((m) => normalizeModel(m, provider)),
        source: 'fallback',
        error: String(error?.message ?? error),
      }
    }
  }

  const fallback = variant === 'global' ? FALLBACK_GLOBAL : FALLBACK_CN
  const provider = variant === 'global' ? 'workbuddy' : 'codebuddy'
  return {
    models: fallback.map((m) => normalizeModel(m, provider)),
    source: 'fallback',
    error: '没有可用账号',
  }
}

/** 清空某个 variant 的缓存（设置页强制刷新用）。 */
export function clearCatalogCache(variant) {
  if (variant) cache.delete(variant)
  else cache.clear()
}
