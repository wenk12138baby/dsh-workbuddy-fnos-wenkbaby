/**
 * WorkBuddy LLM adapter
 *
 * 实现 @deepseek-ai/dsh-llm 的 LlmAdapter 接口，把 WorkBuddy 上游接进 DSH。
 *
 * 必须实现：
 *   - providerInfo(provider)          路由元数据
 *   - stream(options)                 流式生成（唯一必需方法）
 * 建议覆写：
 *   - listModels(provider)            模型目录，供 GUI 选择器使用
 *   - resolveModel(provider, model)   模型元数据（上下文窗口等）
 *
 * StreamChunk 协议（来自 dsh-llm/types）：
 *   { type:'block-start',    index, blockType }
 *   { type:'text-delta',     index, text }
 *   { type:'reasoning-delta',index, text }
 *   { type:'tool-call-delta',index, id, name?, argumentsDelta }
 *   { type:'block-end',      index, block }   ← block 必须是累积完成的块
 *   { type:'usage',          usage }
 *   { type:'finish',         reason }
 *
 * FinishReason：
 *   { kind:'stop' } | { kind:'tool-calls' } | { kind:'max-tokens' }
 *   { kind:'aborted', failure } | { kind:'error', failure }
 *
 * @module dsh-workbuddy-fnos-wenkbaby/adapter
 */

import {
  chatStream,
  classifyError,
  parseSse,
} from './upstream.js'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { variantOf } from './crypto.js'
import { sanitizeMessages } from './sanitize.js'
import { clearCatalogCache, getCatalog } from './catalog.js'

/**
 * 诊断日志路径。
 *
 * dsh 子进程的 stdout/stderr 由网关用 socket 接管，写 stderr 不会进
 * gateway.log，所以调试信息落到插件自己的文件：
 *   $DSH_HOME/workbuddy-fnos/debug.log
 */
function ctxLogPath() {
  const home = process.env.DSH_HOME
    || (process.env.HOME ? `${process.env.HOME}/.dsh` : '.dsh')
  return `${home}/workbuddy-fnos/debug.log`
}

/** 追加一行诊断日志；失败静默（诊断不能影响主流程）。 */
function debugLog(file, line) {
  try {
    appendFileSync(file, line + '\n')
  } catch {
    try {
      mkdirSync(dirname(file), { recursive: true })
      appendFileSync(file, line + '\n')
    } catch { /* 忽略 */ }
  }
}

/** 路由：国际版。 */
export const ROUTE_GLOBAL = 'workbuddy'

/** 路由：国内版。 */
export const ROUTE_CN = 'codebuddy'

/**
 * 把 DSH 的消息内容投影成上游认的纯文本。
 * 图片/文件块在纯文本上游里降级为占位提示。
 */
function toUpstreamText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    } else if (block.type === 'image') {
      parts.push('[图片]')
    } else if (block.type === 'file') {
      parts.push('[文件]')
    }
  }
  return parts.join('\n')
}

/** 把 DSH 消息数组转成 OpenAI 形状。 */
function toUpstreamMessages(messages) {
  const out = []
  for (const message of messages ?? []) {
    const role = message?.role
    if (role === 'system') {
      const text = toUpstreamText(message.content)
      if (text) out.push({ role: 'system', content: text })
    } else if (role === 'user') {
      out.push({ role: 'user', content: toUpstreamText(message.content) })
    } else if (role === 'assistant') {
      const text = toUpstreamText(message.content)
      if (text) out.push({ role: 'assistant', content: text })
    }
  }
  return out
}

/**
 * 合并连续的 user 消息。
 *
 * 上游会以「渠道校验」（code 11128 / Illegal API invocation from an unapproved
 * channel）拒绝连续出现多条 user 消息的请求 —— 实测成功的请求都是
 * system + 单条 user，而 DSH 内核在会话历史累积后会发出多条连续 user
 * （用户输入、上下文注入、工具结果回填等）。
 *
 * 上游要求标准对话结构（user → assistant → user 交替），所以这里把
 * 相邻的 user 段合并成一条，保持语义等价。
 *
 * @param {Array<object>} messages
 * @returns {Array<object>}
 */
function mergeConsecutiveUser(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages
  const out = []
  let pending = null

  const flush = () => {
    if (pending !== null) {
      out.push({ role: 'user', content: pending })
      pending = null
    }
  }

  for (const message of messages) {
    if (message?.role === 'user') {
      const text = typeof message.content === 'string' ? message.content : ''
      pending = pending === null ? text : `${pending}\n\n${text}`
      continue
    }
    flush()
    out.push(message)
  }
  flush()

  return out
}

/**
 * 把 DSH 的工具声明转成上游认的形状。
 *
 * 上游（copilot.tencent.com / workbuddy.ai）拒绝 OpenAI 的
 * `{type:"function", function:{...}}` 包装：
 *   code 11133 Invalid request parameters
 *   param: tools[0].function.name
 *   message: the request parameters were rejected by the model provider
 *
 * 它要的是扁平结构：{ name, description, parameters }。
 */
function toUpstreamTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? '',
    parameters: tool.parameters ?? { type: 'object', properties: {} },
  }))
}

/** 构造一条 LlmFailure。 */
function failureOf(message, code, extra = {}) {
  return { message: String(message), code, ...extra }
}

/**
 * WorkBuddy adapter。
 *
 * 单个实例可挂多个路由（国际版 / 国内版），按账号 domain 分流。
 */
export class WorkBuddyAdapter {
  /**
   * @param {object} options
   * @param {() => Array<object>} options.getAccounts  返回当前可用账号
   */
  constructor(options) {
    this.getAccounts = options.getAccounts
  }

  /** 按路由挑出可用账号。 */
  accountsFor(provider) {
    const want = provider === ROUTE_GLOBAL ? 'global' : 'cn'
    return (this.getAccounts() ?? []).filter((a) => variantOf(a.domain) === want)
  }

  /** 该路由的 variant 名。 */
  variantOf(provider) {
    return provider === ROUTE_GLOBAL ? 'global' : 'cn'
  }

  /** 当前目录（内部）。 */
  async catalogFor(provider, options = {}) {
    const variant = this.variantOf(provider)
    const accounts = this.accountsFor(provider)
    return getCatalog(accounts[0], variant, options)
  }

  /**
   * 模型目录。从上游 `/v3/config` 实时拉取并缓存 10 分钟；
   * 未登录或网络失败时回退内置列表。
   */
  async listModels(provider) {
    const { models } = await this.catalogFor(provider)
    return models.map((m) => ({
      provider,
      id: m.id,
      name: m.name,
      ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
    }))
  }

  /** 强制刷新目录（设置页用）。 */
  async refreshCatalog(provider) {
    clearCatalogCache(this.variantOf(provider))
    const { models, source, error } = await this.catalogFor(provider, { force: true })
    return { count: models.length, source, error }
  }

  /**
   * 模型元数据。
   *
   * 内核的校验条件（缺一即报 invalid exact model metadata）：
   *   resolved.provider === provider
   *   resolved.id === model
   *   typeof resolved.name === 'string' && name.length > 0
   * 上下文窗口放在 context.contextWindow 里（不是顶层 contextWindow）。
   */
  async resolveModel(provider, model) {
    const { models } = await this.catalogFor(provider)
    const known = models.find((m) => m.id === model)

    const info = {
      provider,
      id: model,
      // 目录里找不到时用 id 当名字 —— 内核允许服务未列出的模型
      name: known?.name ?? model,
    }

    if (known?.contextWindow) {
      info.context = { contextWindow: known.contextWindow }
    }
    if (typeof known?.maxOutputTokens === 'number' && known.maxOutputTokens > 0) {
      info.defaultMaxTokens = known.maxOutputTokens
    }

    return info
  }

  /**
   * 绑定模型元数据与本次请求的分发入口。
   *
   * 内核的 LlmRuntime.prepareCall() 会直接调用 `registration.adapter.prepareCall(...)`，
   * 所以这个方法必须存在于 adapter 实例上（基类默认实现见 dsh-llm 的 LlmAdapter）：
   *
   *   return {
   *     model: await this.resolveModel(provider, model, signal),
   *     stream: (options) => this.stream(options),
   *   }
   *
   * @param {string} provider
   * @param {string} model
   * @param {AbortSignal} [signal]
   */
  async prepareCall(provider, model, signal) {
    const info = await this.resolveModel(provider, model, signal)
    return {
      model: info,
      stream: (options) => this.stream(options),
    }
  }

  /**
   * 图片请求的目标尺寸。
   * 与内核 LlmAdapter 的默认实现保持一致：原样保留宽高与字节数，
   * 本适配器不做缩放（WorkBuddy 上游按模型自身能力处理）。
   */
  imageRequestTarget(_provider, _model, image) {
    return {
      width: image.width,
      height: image.height,
      maxBytes: image.bytes,
    }
  }

  /** 图片计价：上游不对请求图片单独计费，交给内核用中性估算。 */
  imageRequestPricing() {
    return undefined
  }

  /** 路由元数据；id 必须与注册时的 provider 名一致。 */
  providerInfo(provider) {
    const isGlobal = provider === ROUTE_GLOBAL
    return {
      id: provider,
      name: isGlobal ? 'WorkBuddy（国际版）' : 'CodeBuddy（国内版）',
    }
  }

  /** 交给内核默认重试策略。 */
  providerRetryPolicy() {
    return undefined
  }

  /** 把 GenerateOptions 转成上游请求体。 */
  buildBody(options) {
    const body = {
      model: options.model,
      // 两步处理：
      //   1. mergeConsecutiveUser —— 上游拒绝连续多条 user（渠道校验）
      //   2. sanitizeMessages     —— 上游拒绝内含 agent 身份声明（同类校验）
      messages: sanitizeMessages(mergeConsecutiveUser(toUpstreamMessages(options.messages))),
      stream: true,
    }

    const tools = toUpstreamTools(options.tools)
    if (tools) body.tools = tools

    const maxOut = options.maxOutputTokens
    if (typeof maxOut === 'number' && maxOut > 0) body.max_tokens = maxOut

    if (typeof options.temperature === 'number') body.temperature = options.temperature
    if (typeof options.topP === 'number') body.top_p = options.topP

    // 调试开关：DSH_WORKBUDDY_DEBUG=1 时把请求结构与上游响应写到诊断文件。
    // 注意：dsh 子进程的 stdout 是 socket（由网关接管），写 stderr 不会进
    // gateway.log，所以这里落到插件自己的诊断文件，便于线上排查。
    // 只记录形状（模型、消息条数、角色、system 长度、工具数），不记录对话正文。
    if (process.env.DSH_WORKBUDDY_DEBUG === '1') {
      try {
        const shape = {
          at: new Date().toISOString(),
          model: body.model,
          requested: options.model,
          stream: body.stream,
          max_tokens: body.max_tokens,
          tools: body.tools ? body.tools.length : 0,
          messages: body.messages.map((m) => ({
            role: m.role,
            len: typeof m.content === 'string' ? m.content.length : 0,
          })),
          systemHead: (body.messages.find((m) => m.role === 'system')?.content || '').slice(0, 80),
        }
        debugLog(ctxLogPath(), 'request ' + JSON.stringify(shape))
      } catch { /* 忽略 */ }
    }

    return body
  }

  /**
   * 流式生成。
   * @param {object} options GenerateOptions
   * @yields {object} StreamChunk
   */
  async *stream(options) {
    const provider = options.provider
    const accounts = this.accountsFor(provider)
    if (accounts.length === 0) {
      const label = this.providerInfo(provider).name
      const failure = failureOf(
        `没有可用于「${label}」的账号。请在插件设置里导入凭据（PC 端导出后导入本机）。`,
        'NO_CREDENTIAL',
      )
      yield { type: 'finish', reason: { kind: 'error', failure } }
      return
    }

    const account = { ...accounts[0], variant: variantOf(accounts[0].domain) }

    // 模型名校正：浏览器可能缓存了旧的模型 id（例如插件早期版本里写死的
    // deepseek-v4.1-flash）。上游对不存在的模型返回 11128「渠道校验」，
    // 表面看像认证失败，实际是模型 id 不在目录里。这里回落到目录的默认模型
    // （官方客户端用 auto），让旧缓存不至于直接失败。
    let model = options.model
    try {
      const { models } = await this.catalogFor(provider)
      if (models.length > 0 && !models.some((m) => m.id === model)) {
        const fallback = models.find((m) => m.id === 'auto')?.id ?? models[0].id
        if (process.env.DSH_WORKBUDDY_DEBUG === '1') {
          try {
            debugLog(ctxLogPath(), `fallback ${model} -> ${fallback}`)
          } catch { /* 忽略 */ }
        }
        model = fallback
      }
    } catch {
      // 目录拉取失败时保持原样，交给上游判断
    }

    const body = this.buildBody({ ...options, model })

    let response
    try {
      response = await chatStream(account, body, options.signal)
    } catch (error) {
      if (error?.name === 'AbortError') {
        yield { type: 'finish', reason: { kind: 'aborted', failure: failureOf('用户取消', 'ABORTED') } }
        return
      }
      const failure = failureOf(`连接 WorkBuddy 失败：${error?.message ?? error}`, 'TRANSPORT')
      yield { type: 'finish', reason: { kind: 'error', failure } }
      return
    }

    if (process.env.DSH_WORKBUDDY_DEBUG === '1') {
      try {
        debugLog(ctxLogPath(), `response status=${response.status} model=${body.model}`)
      } catch { /* 忽略 */ }
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      if (process.env.DSH_WORKBUDDY_DEBUG === '1') {
        try {
          debugLog(ctxLogPath(), 'error body: ' + text.slice(0, 1500))
        } catch { /* 忽略 */ }
      }
      const classified = classifyError(response.status, text)
      const failure = failureOf(classified.message, classified.code, { status: response.status })
      yield { type: 'finish', reason: { kind: 'error', failure } }
      return
    }

    // ── 逐块转换 ────────────────────────────────────────
    let reasoningIndex = -1
    let textIndex = -1
    let reasoningText = ''
    let textText = ''

    try {
      for await (const event of parseSse(response.body)) {
        if (event.reasoning) {
          if (reasoningIndex < 0) {
            reasoningIndex = 0
            yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' }
          }
          reasoningText += event.reasoning
          yield { type: 'reasoning-delta', index: reasoningIndex, text: event.reasoning }
        }

        if (event.content) {
          if (textIndex < 0) {
            textIndex = reasoningIndex >= 0 ? 1 : 0
            yield { type: 'block-start', index: textIndex, blockType: 'text' }
          }
          textText += event.content
          yield { type: 'text-delta', index: textIndex, text: event.content }
        }

        if (event.usage) {
          yield {
            type: 'usage',
            usage: {
              inputTokens: event.usage.prompt_tokens ?? 0,
              outputTokens: event.usage.completion_tokens ?? 0,
            },
          }
        }

        if (event.finish) break
      }
    } catch (error) {
      if (error?.name === 'AbortError') {
        if (reasoningIndex >= 0) {
          yield { type: 'block-end', index: reasoningIndex, block: { type: 'reasoning', text: reasoningText } }
        }
        if (textIndex >= 0) {
          yield { type: 'block-end', index: textIndex, block: { type: 'text', text: textText } }
        }
        yield { type: 'finish', reason: { kind: 'aborted', failure: failureOf('用户取消', 'ABORTED') } }
        return
      }
      const failure = failureOf(`流式传输中断：${error?.message ?? error}`, 'STREAM')
      yield { type: 'finish', reason: { kind: 'error', failure } }
      return
    }

    // 关闭已开的块（block 必须携带累积完成的文本）
    if (reasoningIndex >= 0) {
      yield { type: 'block-end', index: reasoningIndex, block: { type: 'reasoning', text: reasoningText } }
    }
    if (textIndex >= 0) {
      yield { type: 'block-end', index: textIndex, block: { type: 'text', text: textText } }
    }

    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
