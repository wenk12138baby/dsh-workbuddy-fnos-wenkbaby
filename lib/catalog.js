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
 * 上游给的是 `"x0.79 credits"` 这样的字符串，只需去掉尾部的 "credits"，
 * **前面的 `x` 要原样保留** —— 官方客户端的显示就是 `x0.79`，不是 `×0.79`。
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
  return bare === '' ? undefined : bare
}

/**
 * 判断是否免费：倍率为 0（`0.00` 或 `x0.00`）。
 * 官方用 /^x?0\.0+$/ 判定，这里保持一致。
 * @param {string} rate 形如 "x0.00" / "0.00"
 */
function isZeroRate(rate) {
  return /^x?0\.0+$/i.test(String(rate).trim())
}

/**
 * 解析一行的计费信息。
 *
 * 上游 console catalog 里：
 *   credits: "x0.05" | "x2.20 credits" | "x0.00 credits"
 *   tags:    ["craft", "badge:Free now:#FF0000", "badge:限时免费:#FF0000"]
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
    const label = (tag.slice(BADGE_PREFIX.length).split(':')[0] ?? '').trim()
    if (label && !badges.includes(label)) badges.push(label)
  }

  const rate = normalizeCredits(rawCredits)
  const free = rate !== undefined && isZeroRate(rate)

  return { rate, badges, free }
}

/**
 * 把一个模型的计费信息拼成显示名后缀。
 *
 * 与官方客户端完全一致：倍率在前，badge 依次在后，用 ` · ` 连接。
 * **不要替换成中文「免费」** —— 官方就是直接显示 `x0.00` 和上游给的
 * badge 原文（如 `Free now`、`限时免费`）。
 *
 * @param {object} entry
 * @returns {string|undefined}
 */
function displaySuffix(entry) {
  const { rate, badges } = parseBilling(entry)
  const parts = []
  if (rate !== undefined && rate !== '') parts.push(rate)
  for (const badge of badges) {
    if (badge !== '' && !parts.includes(badge)) parts.push(badge)
  }
  return parts.length === 0 ? undefined : parts.join(SUFFIX_SEPARATOR)
}

/**
 * 解析 `/v3/config` 的 `data.modelPromotions`。
 *
 * 国际版的促销标签（`Free now`）不在模型行上，而是这个顶层数组里：
 *   {
 *     enabled: true,
 *     modelIds: ["hy3"],
 *     discount: { displayMode: "replace", factor: 0, discountedCredits: "0x" },
 *     badge: { color: "#FF0000", label: "Free now", display: "activeOnly" },
 *     schedule: { validFrom: "...", validUntil: "..." },
 *     priority: 200
 *   }
 *
 * 只有同时满足以下条件才算生效：
 *   - enabled === true
 *   - discount.displayMode === "replace"（用折扣价覆盖原倍率）
 *   - 当前时间落在 schedule 的有效期内
 *
 * @param {unknown} value modelPromotions 原始值
 * @param {number} [nowMs] 当前时间，便于测试注入
 * @returns {Map<string, { label: string, rate?: string, priority: number }>}
 *          模型 id -> 生效中的促销（同一模型取 priority 最高的）
 */
function parseModelPromotions(value, nowMs = Date.now()) {
  const out = new Map()
  if (!Array.isArray(value)) return out

  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    if (item.enabled !== true) continue

    const discount = item.discount
    if (!discount || typeof discount !== 'object') continue
    // 只有 replace 模式才覆盖倍率显示
    if (discount.displayMode !== 'replace') continue

    const modelIds = Array.isArray(item.modelIds) ? item.modelIds : []
    if (modelIds.length === 0) continue

    // 有效期校验
    const schedule = item.schedule
    if (schedule && typeof schedule === 'object') {
      const from = typeof schedule.validFrom === 'string' ? Date.parse(schedule.validFrom) : NaN
      const until = typeof schedule.validUntil === 'string' ? Date.parse(schedule.validUntil) : NaN
      if (Number.isFinite(from) && nowMs < from) continue
      if (Number.isFinite(until) && nowMs >= until) continue
    }

    const badge = item.badge
    const label = badge && typeof badge.label === 'string' ? badge.label.trim() : ''
    if (!label) continue

    // 折扣后的倍率：factor 为数字时按 x{n} 显示
    let rate
    const factor = discount.factor
    if (typeof factor === 'number' && Number.isFinite(factor) && factor >= 0) {
      rate = `x${factor.toFixed(2)}`
    } else if (typeof discount.discountedCredits === 'string' && discount.discountedCredits.trim()) {
      rate = normalizeCredits(discount.discountedCredits)
    }

    const priority = typeof item.priority === 'number' ? item.priority : 0
    for (const id of modelIds) {
      if (typeof id !== 'string') continue
      const prev = out.get(id)
      if (prev && prev.priority >= priority) continue
      out.set(id, { label, rate, priority })
    }
  }
  return out
}

/**
 * 把计费信息合并进模型列表。
 *
 * 只改 `name`（用于显示），`id` 保持原样 —— 请求路由用的是 id，
 * 内核也只校验 name 是非空字符串，不会按名字反查模型。
 *
 * 促销优先于模型行自带的倍率：命中促销时用促销的 rate + label，
 * 否则退回行上的 credits 与 badge tags。
 *
 * @param {Array<object>} models normalizeModel 产出的列表
 * @param {Array<object>} rows 合并后的原始行（含 credits / tags）
 * @param {Map<string, object>} [promotions] parseModelPromotions 的结果
 * @returns {Array<object>}
 */
function applyBilling(models, rows, promotions) {
  const byId = new Map()
  for (const row of rows ?? []) {
    if (row && typeof row.id === 'string') byId.set(row.id, row)
  }

  return models.map((model) => {
    const parts = []

    // 1) 促销（国际版的 "Free now" 走这条）
    const promo = promotions?.get(model.id)
    if (promo) {
      if (promo.rate) parts.push(promo.rate)
      parts.push(promo.label)
    }

    // 2) 模型行自带的 credits / badge tags（国内版走这条）
    const row = byId.get(model.id)
    if (row) {
      const suffix = displaySuffix(row)
      if (suffix) {
        for (const piece of suffix.split(SUFFIX_SEPARATOR)) {
          if (piece && !parts.includes(piece)) parts.push(piece)
        }
      }
    }

    if (parts.length === 0) return model
    return { ...model, name: `${model.name}${SUFFIX_SEPARATOR}${parts.join(SUFFIX_SEPARATOR)}` }
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

  // 国际版的计费字段（credits）挂在 /v3/config 的每一行上，
  // 促销标签（badge: Free now）在 data.modelPromotions 这个顶层数组里；
  // 国内版这两处都没有，要去 console catalog 取。
  // 这里把原始行与促销数组一并返回，由调用方决定怎么合并。
  return { models, rawRows: list, promotions: doc?.data?.modelPromotions }
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
      const { models, rawRows, promotions } = await fetchCatalog(account, variant)

      // 计费标注是显示增强：拉不到也不影响模型可用性。
      //
      // 两个版本的数据来源不同，两处都要读、并按模型 id 合并：
      //   国际版 — 倍率在 /v3/config 的 models[].credits 上，
      //            促销标签（Free now）在 data.modelPromotions 上
      //            （console catalog 在国际版返回 500）
      //   国内版 — /v3/config 没有计费字段，要去 console catalog 取
      const consoleRows = await fetchConsoleCatalog(account, variant)

      // 先合并两份原始行：console 的字段覆盖 config 的同名字段，
      // 但 config 有的（国际版的 credits）要保留。
      const merged = new Map()
      for (const row of rawRows ?? []) {
        if (row && typeof row.id === 'string') merged.set(row.id, { ...row })
      }
      for (const row of consoleRows ?? []) {
        if (!row || typeof row.id !== 'string') continue
        const prev = merged.get(row.id)
        merged.set(row.id, prev ? { ...prev, ...row } : { ...row })
      }

      const promoMap = parseModelPromotions(promotions)
      const enriched = applyBilling(models, [...merged.values()], promoMap)
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
