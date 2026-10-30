/**
 * 账号池适配层
 *
 * 把 dsh-workbuddy-connect 原本「单账号单文件」的 WorkBuddyCredentialStore
 * 扩展成「多账号池 + 每版本一个激活账号」。
 *
 * 做法是**包装**而不是改写：
 *   - current() / resolve() 先看池里该版本有没有激活账号，有就返回它
 *   - 没有则回退到原始 store 的行为（读桌面文件、读旧副本）
 *   - refresh 之后把新凭据写回池，保持池是最新的
 *
 * 这样 connect 的原有逻辑（桌面文件探测、密钥获取、自动续期）完全不受影响，
 * 只是多了一层「优先用池里选中的那个账号」。
 *
 * @module dsh-workbuddy-fnos-wenkbaby/pool-store
 */

import {
  activeOf,
  loadPool,
  upsertAccount,
  writePool,
} from './accounts.js'

/**
 * 把池里的 credential 转成 connect 期望的运行时凭据形状。
 *
 * connect 内部用的字段：accessToken / refreshToken / expiresAtMs /
 * refreshExpiresAtMs / domain / uid / nickname / enterpriseId / source。
 */
function toRuntimeCredential(stored, sourceTag) {
  return {
    accessToken: stored.accessToken,
    refreshToken: typeof stored.refreshToken === 'string' ? stored.refreshToken : '',
    expiresAtMs: typeof stored.expiresAtMs === 'number' ? stored.expiresAtMs : 0,
    ...(typeof stored.refreshExpiresAtMs === 'number'
      ? { refreshExpiresAtMs: stored.refreshExpiresAtMs }
      : {}),
    domain: typeof stored.domain === 'string' ? stored.domain : '',
    uid: typeof stored.uid === 'string' ? stored.uid : '',
    ...(typeof stored.nickname === 'string' && stored.nickname
      ? { nickname: stored.nickname }
      : {}),
    ...(typeof stored.enterpriseId === 'string' && stored.enterpriseId
      ? { enterpriseId: stored.enterpriseId }
      : {}),
    source: sourceTag,
  }
}

/** 凭据是否需要续期（留 5 分钟余量）。 */
function needsRefresh(credential, marginMs = 300000) {
  if (!credential) return false
  if (!credential.refreshToken) return false
  const exp = credential.expiresAtMs
  if (typeof exp !== 'number' || exp <= 0) return false
  return Date.now() + marginMs >= exp
}

/**
 * 包装一个 WorkBuddyCredentialStore。
 *
 * @param {object} base 原始的 WorkBuddyCredentialStore 实例
 * @param {{id:string}} variant 变体（cn / ai）
 * @returns {object} 形状与 base 相同的对象，但优先读池
 */
export function wrapWithPool(base, variant) {
  const variantId = variant?.id === 'ai' ? 'ai' : 'cn'

  /** 读池里该版本的激活账号；没有返回 undefined。 */
  function fromPool() {
    try {
      const pool = loadPool()
      const entry = activeOf(pool, variantId)
      if (!entry) return undefined
      return toRuntimeCredential(entry.credential, 'account-pool')
    } catch {
      return undefined
    }
  }

  /** 把一次成功刷新后的凭据写回池。 */
  function saveBack(credential) {
    if (!credential || typeof credential.accessToken !== 'string') return
    try {
      const pool = loadPool()
      const entry = activeOf(pool, variantId)
      // 池里没有该账号就跳过，避免把回退来源的凭据塞进池
      if (!entry) return
      if (entry.uid && credential.uid && entry.uid !== credential.uid) return
      upsertAccount(pool, variantId, {
        accessToken: credential.accessToken,
        refreshToken: credential.refreshToken,
        expiresAtMs: credential.expiresAtMs,
        ...(typeof credential.refreshExpiresAtMs === 'number'
          ? { refreshExpiresAtMs: credential.refreshExpiresAtMs }
          : {}),
        domain: credential.domain,
        uid: entry.uid || credential.uid || '',
        nickname: credential.nickname || entry.credential.nickname || '',
        enterpriseId: credential.enterpriseId || entry.credential.enterpriseId || '',
      }, false)
      writePool(pool)
    } catch {
      // 写回失败不影响本次请求
    }
  }

  return {
    // ── 池优先的读取 ──

    /** 读当前凭据：池优先，回退到 base。 */
    async current() {
      const pooled = fromPool()
      if (pooled) return pooled
      return base.current()
    },

    /** 取可用凭据：池优先；池里的过期了就走 base 的续期逻辑。 */
    async resolve() {
      const pooled = fromPool()
      if (pooled) {
        if (!needsRefresh(pooled)) return pooled
        // 需要续期：交给 base 处理（它会用 refreshToken 换新）
        try {
          const refreshed = await base.resolve()
          saveBack(refreshed)
          return refreshed
        } catch {
          // 续期失败就先用旧的，让上游去判
          return pooled
        }
      }
      const credential = await base.resolve()
      saveBack(credential)
      return credential
    },

    /** 状态摘要：池优先，回退到 base。 */
    async status() {
      const pooled = fromPool()
      if (pooled) {
        const expired = typeof pooled.expiresAtMs === 'number'
          && pooled.expiresAtMs > 0
          && Date.now() >= pooled.expiresAtMs
        return {
          state: 'signed-in',
          expiresAtMs: pooled.expiresAtMs,
          ...(typeof pooled.refreshExpiresAtMs === 'number'
            ? { refreshExpiresAtMs: pooled.refreshExpiresAtMs }
            : {}),
          ...(pooled.nickname ? { nickname: pooled.nickname } : {}),
          ...(pooled.domain ? { domain: pooled.domain } : {}),
          source: 'account-pool',
          ...(expired ? { expired: true } : {}),
        }
      }
      return base.status()
    },

    // ── 原样转发 ──

    desktopAuthPath() {
      return base.desktopAuthPath()
    },

    ownAuthPath() {
      return base.ownAuthPath()
    },

    resolvedDesktopAuthPath() {
      return base.resolvedDesktopAuthPath?.()
    },

    setDesktopPath(path) {
      return base.setDesktopPath?.(path)
    },
  }
}

/**
 * 池的管理操作（供设置页 API 调用）。
 */
export const AccountManager = {
  /** 列出所有账号与激活状态。 */
  list() {
    const pool = loadPool()
    return {
      active: { ...pool.active },
      accounts: pool.accounts.map((a) => ({
        variant: a.variant,
        uid: a.uid,
        nickname: typeof a.credential.nickname === 'string' ? a.credential.nickname : '',
        domain: typeof a.credential.domain === 'string' ? a.credential.domain : '',
        expiresAtMs: typeof a.credential.expiresAtMs === 'number' ? a.credential.expiresAtMs : 0,
        active: pool.active[a.variant] === a.uid,
      })),
    }
  },

  /** 切换激活账号。 */
  activate(variant, uid) {
    const pool = loadPool()
    const found = pool.accounts.find((a) => a.variant === variant && a.uid === uid)
    if (!found) return { ok: false, error: '找不到该账号' }
    pool.active[variant] = uid
    writePool(pool)
    return { ok: true }
  },

  /** 删除账号。 */
  remove(variant, uid) {
    const pool = loadPool()
    const before = pool.accounts.length
    pool.accounts = pool.accounts.filter((a) => !(a.variant === variant && a.uid === uid))
    if (pool.accounts.length === before) return { ok: false, error: '找不到该账号' }

    if (pool.active[variant] === uid) {
      const next = pool.accounts.find((a) => a.variant === variant)
      if (next) pool.active[variant] = next.uid
      else delete pool.active[variant]
    }
    writePool(pool)
    return { ok: true, remaining: pool.accounts.filter((a) => a.variant === variant).length }
  },

  /** 导出。 */
  export() {
    const pool = loadPool()
    return {
      schema: 'dsh-workbuddy-export/v1',
      exportedAt: new Date().toISOString(),
      warning: '此文件包含明文访问令牌。任何拿到它的人都能使用你的 WorkBuddy 额度，请勿分享或上传到公共位置。',
      accounts: pool.accounts.map((a) => ({
        variant: a.variant,
        uid: a.uid,
        nickname: typeof a.credential.nickname === 'string' ? a.credential.nickname : '',
        domain: typeof a.credential.domain === 'string' ? a.credential.domain : '',
        credential: a.credential,
      })),
    }
  },

  /** 导入：接受导出文档、裸账号数组、单个 credential 或桌面 auth.info。 */
  import(text) {
    let doc
    try {
      doc = typeof text === 'string' ? JSON.parse(text) : text
    } catch {
      return { ok: false, error: '不是合法的 JSON' }
    }

    const entries = []
    const push = (variant, credential) => {
      if (!credential || typeof credential !== 'object') return
      if (typeof credential.accessToken !== 'string' || !credential.accessToken) return
      const v = variant === 'ai' ? 'ai' : variant === 'cn' ? 'cn' : undefined
      if (!v) return
      entries.push({ variant: v, credential })
    }

    if (Array.isArray(doc?.accounts)) {
      for (const item of doc.accounts) push(item?.variant, item?.credential)
    } else if (doc?.credential && typeof doc.credential === 'object') {
      const domain = typeof doc.credential.domain === 'string' ? doc.credential.domain : ''
      push(/(^|\.)workbuddy\.ai$/i.test(domain) ? 'ai' : 'cn', doc.credential)
    } else if (doc?.auth && typeof doc.auth.accessToken === 'string') {
      const domain = typeof doc.auth.domain === 'string' ? doc.auth.domain : ''
      const account = doc.account && typeof doc.account === 'object' ? doc.account : {}
      push(/(^|\.)workbuddy\.ai$/i.test(domain) ? 'ai' : 'cn', {
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
      return { ok: false, error: '没有找到可导入的账号（缺少 accessToken）' }
    }

    const pool = loadPool()
    let added = 0
    let updated = 0
    for (const { variant, credential } of entries) {
      const result = upsertAccount(pool, variant, credential, true)
      if (result.added) added += 1
      else updated += 1
    }
    writePool(pool)

    return {
      ok: true,
      added,
      updated,
      total: pool.accounts.length,
      active: { ...pool.active },
    }
  },
}
