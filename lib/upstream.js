/**
 * WorkBuddy 上游客户端
 *
 * 负责三件事：
 *   1. 定位 WorkBuddy 二进制并取 atRestSecretKey（本机解密时需要）
 *   2. 构造官方同款请求头（这是能通过「渠道校验」的关键）
 *   3. 发送 chat/completions 并解析 SSE 流
 *
 * 请求头为什么重要：
 *   自 2026-10-16 起，缺少 X-Conversation-* 三件套（ID / Request-ID / Message-ID）
 *   或缺少 X-IDE-* 身份头，服务端返回 400 + code 11128 + "request illegal"，
 *   displayTips 会提示「这次调用没通过渠道校验，可能不是官方客户端发出的」。
 *
 * @module dsh-workbuddy-fnos-wenkbaby/upstream
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 国际版聊天端点。 */
export const GLOBAL_CHAT_BASE = 'https://www.workbuddy.ai'

/** 国内版聊天端点。 */
export const CN_CHAT_BASE = 'https://copilot.tencent.com'

/** 国际版站点（Origin / Referer 用）。 */
export const GLOBAL_SITE = 'https://www.workbuddy.ai'

/** 国内版站点（Origin / Referer 用）。 */
export const CN_SITE = 'https://www.codebuddy.cn'

/** 官方更新接口：返回 Linux 各通道的下载地址与 sha256。 */
const UPDATE_ENDPOINT = 'https://copilot.tencent.com/v2/update'

/** 已知的 WorkBuddy 二进制位置（按平台）。 */
export function candidateBinaries() {
  const home = os.homedir()
  const list = []

  if (process.platform === 'win32') {
    const la = process.env.LOCALAPPDATA
    const pf = process.env.PROGRAMFILES
    const pf86 = process.env['PROGRAMFILES(X86)']
    if (la) {
      list.push(path.join(la, 'Programs', 'WorkBuddyAI', 'WorkBuddyAI.exe'))
      list.push(path.join(la, 'Programs', 'WorkBuddy', 'WorkBuddy.exe'))
    }
    if (pf) {
      list.push(path.join(pf, 'WorkBuddy', 'WorkBuddy.exe'))
      list.push(path.join(pf, 'WorkBuddyAI', 'WorkBuddyAI.exe'))
    }
    if (pf86) {
      list.push(path.join(pf86, 'WorkBuddy', 'WorkBuddy.exe'))
    }
  } else if (process.platform === 'darwin') {
    list.push('/Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy')
    list.push('/Applications/WorkBuddyAI.app/Contents/MacOS/WorkBuddyAI')
    list.push(path.join(home, 'Applications', 'WorkBuddy.app', 'Contents', 'MacOS', 'WorkBuddy'))
  } else {
    // Linux：官方 deb 装到 /opt/WorkBuddy；解包态也常见
    list.push('/opt/WorkBuddy/workbuddy')
    list.push('/opt/WorkBuddyAI/workbuddy-ai')
    list.push('/usr/bin/workbuddy')
    list.push(path.join(home, '.local', 'opt', 'WorkBuddy', 'workbuddy'))
  }

  // 环境变量覆盖（调试/自定义安装用）
  if (process.env.WORKBUDDY_ELECTRON_BIN) list.unshift(process.env.WORKBUDDY_ELECTRON_BIN)

  return list
}

/** 返回第一个存在的二进制路径，没有则 undefined。 */
export function findBinary() {
  for (const p of candidateBinaries()) {
    try {
      if (p && existsSync(p)) return p
    } catch {
      // 权限或路径异常，继续找
    }
  }
  return undefined
}

/** 取密钥时在二进制里执行的脚本；只输出 payload，不写其它东西。 */
const KEY_HELPER = `
try {
  const b = process._linkedBinding("electron_browser_workbuddy_storage");
  const payload = JSON.parse(b.loggerGet());
  process.stdout.write(JSON.stringify({ ok: true, atRestSecretKey: payload.atRestSecretKey }));
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
}
`

/**
 * 调用 WorkBuddy 二进制取 atRestSecretKey。
 *
 * 原理：Electron 应用在 ELECTRON_RUN_AS_NODE=1 时以纯 Node 模式运行，
 * 但保留了 _linkedBinding 对私有 native 模块的访问。这是官方客户端自己
 * 读取加密凭据的同一入口。
 *
 * @param {string} binPath
 * @param {number} [timeoutMs]
 * @returns {Promise<string>} atRestSecretKey
 */
export function readAtRestSecretKey(binPath, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn(binPath, ['-e', KEY_HELPER], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })

    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { out += chunk })

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`读取密钥超时（${timeoutMs}ms）`))
    }, timeoutMs)

    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new Error(`无法启动 WorkBuddy：${error.message}`))
    })

    child.on('close', () => {
      clearTimeout(timer)
      // 二进制会往 stdout 打大量日志，取最后一行 JSON
      const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i]
        if (!line.startsWith('{')) continue
        try {
          const parsed = JSON.parse(line)
          if (parsed.ok === true && typeof parsed.atRestSecretKey === 'string') {
            resolve(parsed.atRestSecretKey)
            return
          }
          if (parsed.ok === false) {
            reject(new Error(parsed.error || '绑定不可用'))
            return
          }
        } catch {
          // 不是我们要的那行
        }
      }
      reject(new Error('未从 WorkBuddy 输出中找到密钥'))
    })
  })
}

/**
 * 查询官方 Linux 包的最新下载地址。
 * @param {'workbuddy-linux-x64-deb'|'workbuddy-linux-arm64-deb'|'workbuddy-linux-x64-rpm'|'workbuddy-linux-arm64-rpm'} platform
 * @returns {Promise<{version:string,url:string,sha256:string}>}
 */
export async function queryLinuxDownload(platform) {
  const url = `${UPDATE_ENDPOINT}?platform=${encodeURIComponent(platform)}`
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) })
  if (!response.ok) throw new Error(`更新接口返回 HTTP ${response.status}`)
  const data = await response.json()
  if (!data?.url) throw new Error('更新接口未返回下载地址')
  return {
    version: String(data.version ?? ''),
    url: String(data.url),
    sha256: String(data.sha256hash ?? ''),
  }
}

/** 按机器架构挑 Linux 通道。 */
export function linuxDownloadPlatform() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const isRpm = existsSync('/etc/redhat-release') || existsSync('/etc/fedora-release')
  return `workbuddy-linux-${arch}-${isRpm ? 'rpm' : 'deb'}`
}

/** 客户端 UA —— 与服务端识别的官方桌面端一致。 */
export function clientUserAgent() {
  return 'WorkBuddy/5.6.2 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)'
}

/**
 * 构造聊天请求头。
 *
 * 这些头是「通过渠道校验」的必要条件，缺任何一个都会 11128。
 *
 * @param {object} account  { accessToken, uid, enterpriseId, domain }
 * @param {'global'|'cn'} variant
 */
export function buildChatHeaders(account, variant) {
  const site = variant === 'global' ? GLOBAL_SITE : CN_SITE
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: site,
    Referer: `${site}/`,
    'User-Agent': clientUserAgent(),
    Authorization: `Bearer ${account.accessToken}`,
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': '5.6.2',
    'X-Product': 'SaaS',
    // 会话三件套：官方客户端每条请求都带，缺了会被判为「非官方客户端」
    'X-Conversation-ID': randomUUID(),
    'X-Conversation-Request-ID': randomUUID(),
    'X-Conversation-Message-ID': randomUUID(),
  }

  if (account.uid) headers['X-User-Id'] = account.uid
  else headers['X-No-User-Id'] = '1'

  if (account.enterpriseId) headers['X-Enterprise-Id'] = account.enterpriseId
  else headers['X-No-Enterprise-Id'] = '1'

  if (account.domain) headers['X-Domain'] = account.domain
  else headers['X-No-Department-Info'] = '1'

  return headers
}

/** 聊天端点。 */
export function chatBase(variant) {
  return variant === 'global' ? GLOBAL_CHAT_BASE : CN_CHAT_BASE
}

/**
 * 发起聊天请求，返回原始 Response（SSE 流）。
 *
 * @param {object} account
 * @param {object} body     OpenAI 形状的请求体
 * @param {AbortSignal} [signal]
 */
export async function chatStream(account, body, signal) {
  const variant = account.variant === 'global' ? 'global' : 'cn'
  const url = `${chatBase(variant)}/v2/chat/completions`

  // 国际版要求首条为 system 消息，否则会被服务端补默认提示词影响行为
  const payload = { ...body, stream: true }
  if (variant === 'global' && Array.isArray(payload.messages)) {
    const first = payload.messages[0]
    if (!first || first.role !== 'system') {
      payload.messages = [
        { role: 'system', content: 'You are a helpful assistant.' },
        ...payload.messages,
      ]
    }
  }

  return fetch(url, {
    method: 'POST',
    headers: buildChatHeaders(account, variant),
    body: JSON.stringify(payload),
    signal,
  })
}

/**
 * 把 SSE 流解析成增量事件。
 *
 * 上游事件形如：
 *   data: {"choices":[{"delta":{"content":"..."}}]}
 *   : heartbeat
 *   data: [DONE]
 *
 * @param {ReadableStream<Uint8Array>} stream
 * @yields {{ content?: string, reasoning?: string, finish?: string, usage?: object }}
 */
export async function* parseSse(stream) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const drain = function* (raw) {
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith(':')) continue
      if (!trimmed.startsWith('data:')) continue
      const data = trimmed.slice(5).trim()
      if (data === '[DONE]') return 'done'
      let parsed
      try {
        parsed = JSON.parse(data)
      } catch {
        continue
      }
      const choice = parsed?.choices?.[0]
      const usage = parsed?.usage
      const out = {}
      if (choice) {
        const delta = choice.delta ?? {}
        if (typeof delta.content === 'string') out.content = delta.content
        if (typeof delta.reasoning_content === 'string') out.reasoning = delta.reasoning_content
        if (choice.finish_reason) out.finish = choice.finish_reason
      }
      if (usage && typeof usage === 'object') {
        out.usage = {
          prompt_tokens: Number(usage.prompt_tokens) || 0,
          completion_tokens: Number(usage.completion_tokens) || 0,
          total_tokens: Number(usage.total_tokens) || 0,
        }
      }
      if (Object.keys(out).length > 0) yield out
    }
    return 'continue'
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // SSE 事件以空行分隔；同时兼容 \r\n\r\n
      let sep
      while ((sep = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const raw = buffer.slice(0, sep)
        buffer = buffer.slice(sep + (buffer[sep] === '\r' ? 4 : 2))
        const status = yield* drain(raw)
        if (status === 'done') return
      }
    }
    // 收尾：处理没有以空行结束的最后一个事件
    if (buffer.trim()) yield* drain(buffer)
  } finally {
    reader.releaseLock()
  }
}

/** 把上游错误体归类，转成用户看得懂的提示。 */
export function classifyError(status, bodyText) {
  const text = String(bodyText || '')
  // 11128 = 渠道校验失败；11140 = 安全策略拦截
  if (status === 400 && /"code"\s*:\s*11128/.test(text)) {
    return {
      code: 'CHANNEL_REJECTED',
      message: '请求未通过渠道校验。可能是请求头不完整，或该版本的客户端身份已失效。',
    }
  }
  if (/"code"\s*:\s*11140/.test(text) || /request illegal/i.test(text)) {
    return {
      code: 'CONTENT_REJECTED',
      message: '该请求被服务端安全策略拦截。可稍后重试，或改用其他模型。',
    }
  }
  if (status === 429) {
    return {
      code: 'RATE_LIMITED',
      message: '当前模型触发频率限制。稍等片刻（通常 1-3 分钟）再试，或切换其他模型。',
    }
  }
  if (status === 401 || status === 403) {
    return {
      code: 'UNAUTHORIZED',
      message: '凭据已失效。请重新在 PC 端导出凭据，再导入到本插件。',
    }
  }
  return { code: 'UPSTREAM', message: text.slice(0, 300) || `上游返回 HTTP ${status}` }
}
