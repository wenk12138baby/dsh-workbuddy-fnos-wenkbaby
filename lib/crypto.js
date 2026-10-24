/**
 * WorkBuddy 凭据解密
 *
 * 三层加密体系（逆向自官方客户端 resources/app.asar）：
 *
 *   第 1 层  atRestSecretKey
 *           由 WorkBuddy 二进制自己的 native 绑定生成：
 *             process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()
 *           返回 JSON：{ version, atRestSecretKey, atRestDeveloperPublicKey }
 *           该密钥对同一份二进制是确定性的（删掉所有用户目录也不变）。
 *
 *   第 2 层  auth.info 里的 token 字段
 *           `{ $wbEncrypted: 1, envelope: "<base64>" }`
 *           envelope 解码后：{ suite, keyId, nonce, authTag, ciphertext }
 *           用 AES-256-GCM 解密，AAD 由 buildAad() 构造。
 *
 *   第 3 层  keyblob（~/.workbuddy/keyblob）
 *           存放被 protector 包裹的 master key。目前不需要它 —— 凭据字段直接用
 *           第 2 层的 protector key 解密。
 *
 * 关键常量（全部来自 app.asar）：
 *   AAD_DOMAIN         = "WB-AAD\0"   （ASCII，含 NUL，共 7 字节）
 *   STANDARD_FORMAT_ID = { file:"WBEF1", field:"WBEV1", record:"WBER1", stream:"WBES1" }
 *   FRAMING_CODE       = { file:1, field:2, record:3, stream:4 }
 *
 * 注意 framing：auth.info 的 token 字段用 "field"，keyblob 的 wrapped 槽用 "file"，
 * 两者都要尝试，因为不同版本可能不同。
 *
 * @module dsh-workbuddy-fnos-wenkbaby/crypto
 */

import crypto from 'node:crypto'

/** AAD 域前缀：ASCII 的 "WB-AAD" 后跟一个 NUL 字节。 */
const AAD_DOMAIN = Buffer.from('WB-AAD\0', 'ascii')

/** 各 framing 的格式标识（写进 AAD）。 */
const STANDARD_FORMAT_ID = {
  file: 'WBEF1',
  field: 'WBEV1',
  record: 'WBER1',
  stream: 'WBES1',
}

/** 各 framing 的编码（写进 AAD 的最后一个字段）。 */
const FRAMING_CODE = {
  file: 1,
  field: 2,
  record: 3,
  stream: 4,
}

/** 大端 uint32。 */
function encodeUint32(value) {
  const bytes = Buffer.allocUnsafe(4)
  bytes.writeUInt32BE(value)
  return bytes
}

/** 长度前缀编码：4 字节大端长度 + UTF-8 内容。 */
function encodeLengthPrefixed(value) {
  const bytes = Buffer.from(value, 'utf8')
  return Buffer.concat([encodeUint32(bytes.length), bytes])
}

/**
 * 可选 uint64：undefined 编码成单字节 0，否则 1 + 8 字节大端值。
 * 凭据字段不带 sequence，所以走单字节 0 分支。
 */
function encodeOptionalUint64(value) {
  if (value === undefined) return Buffer.from([0])
  const bytes = Buffer.allocUnsafe(9)
  bytes[0] = 1
  bytes.writeBigUInt64BE(BigInt(value), 1)
  return bytes
}

/**
 * 构造 sme-v1 的 AAD。
 *
 * 结构（与官方 buildAuthenticatedContextAad 的 sym-v1 分支逐字节一致）：
 *   AAD_DOMAIN
 *   [1]                        方案版本
 *   lp(STANDARD_FORMAT_ID[fr]) 格式标识
 *   lp("sym-v1")               方案名
 *   u32(suite)                 suite 号
 *   lp(keyId)                  16 位小写 hex
 *   [FRAMING_CODE[fr]]         framing 码
 *   optional-uint64(sequence)  此处恒为 [0]
 *   [final === undefined ? 0]  此处恒为 [0]
 *
 * @param {string} keyId  16 位小写十六进制
 * @param {number} suite  1
 * @param {'file'|'field'|'record'|'stream'} framing
 * @returns {Buffer}
 */
export function buildAad(keyId, suite, framing) {
  if (!/^[0-9a-f]{16}$/.test(keyId)) throw new TypeError('keyId must be 16 lowercase hex characters')
  return Buffer.concat([
    AAD_DOMAIN,
    Buffer.from([1]),
    encodeLengthPrefixed(STANDARD_FORMAT_ID[framing]),
    encodeLengthPrefixed('sym-v1'),
    encodeUint32(suite),
    encodeLengthPrefixed(keyId),
    Buffer.from([FRAMING_CODE[framing]]),
    encodeOptionalUint64(undefined),
    Buffer.from([0]),
  ])
}

/**
 * 由 atRestSecretKey 派生保护密钥。
 *
 *   key   = sha256(atRestSecretKey 的 UTF-8 字节)       -> 32 字节
 *   keyId = sha256(key) 的 hex 前 16 位
 *
 * @param {string} atRestSecretKey  44 字符 base64
 * @returns {{ key: Buffer, keyId: string }}
 */
export function deriveProtectorKey(atRestSecretKey) {
  if (typeof atRestSecretKey !== 'string' || atRestSecretKey.length === 0) {
    throw new TypeError('atRestSecretKey must be a non-empty string')
  }
  const key = crypto.createHash('sha256').update(atRestSecretKey, 'utf8').digest()
  const keyId = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)
  return { key, keyId }
}

/**
 * 用保护密钥解开一个 envelope（AES-256-GCM）。
 *
 * @param {Buffer} key     32 字节密钥
 * @param {string} keyId   期望的 keyId
 * @param {object} envelope { suite, keyId, nonce, authTag, ciphertext }，base64 字段
 * @param {'file'|'field'|'record'|'stream'} framing
 * @returns {string} 明文 UTF-8
 */
export function decryptEnvelopeWith(key, keyId, envelope, framing) {
  if (envelope.keyId !== keyId) {
    throw new Error(`keyId mismatch: envelope=${envelope.keyId} expected=${keyId}`)
  }
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(envelope.nonce, 'base64'),
    { authTagLength: 16 },
  )
  decipher.setAAD(buildAad(envelope.keyId, envelope.suite, framing))
  decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'))
  const plain = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ])
  return plain.toString('utf8')
}

/** 把 base64 的 envelope 字符串解析成对象。 */
export function parseEnvelope(envelopeBase64) {
  return JSON.parse(Buffer.from(envelopeBase64, 'base64').toString('utf8'))
}

/**
 * 判断一个值是否是 `{ $wbEncrypted: 1, envelope }` 包装。
 * 官方客户端 5.6+ 对 token 字段默认启用这种包装。
 */
export function isEncryptedField(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    value.$wbEncrypted === 1 &&
    typeof value.envelope === 'string'
  )
}

/**
 * 解密一个字段：明文原样返回，加密包装则解开。
 * framing 依次尝试 field 与 file —— 不同字段/版本可能不同。
 *
 * @param {Buffer} key
 * @param {string} keyId
 * @param {unknown} value
 * @returns {string|null} 解析失败返回 null
 */
export function decryptField(key, keyId, value) {
  if (typeof value === 'string') return value
  if (!isEncryptedField(value)) return null

  let envelope
  try {
    envelope = parseEnvelope(value.envelope)
  } catch {
    return null
  }

  for (const framing of ['field', 'file']) {
    try {
      return decryptEnvelopeWith(key, keyId, envelope, framing)
    } catch {
      // 换下一个 framing
    }
  }
  return null
}

/**
 * 从 auth.info 文档里解出可用的账号信息。
 *
 * @param {object} doc   auth.info 的 JSON
 * @param {Buffer} key   protector key
 * @param {string} keyId protector keyId
 * @returns {{ domain, uid, nickname, enterpriseId, accessToken, refreshToken, expiresAt }|null}
 */
export function extractAccount(doc, key, keyId) {
  const auth = doc?.auth
  if (!auth || typeof auth !== 'object') return null

  const accessToken = decryptField(key, keyId, auth.accessToken)
  if (!accessToken) return null

  const account = doc.account ?? (Array.isArray(doc.accounts) ? doc.accounts[0] : undefined) ?? {}
  const refreshToken = decryptField(key, keyId, auth.refreshToken) || ''
  const nickname = decryptField(key, keyId, account.nickname) || ''

  return {
    domain: typeof auth.domain === 'string' ? auth.domain : '',
    uid: typeof account.uid === 'string' ? account.uid : '',
    nickname,
    enterpriseId: typeof account.enterpriseId === 'string' ? account.enterpriseId : '',
    accessToken,
    refreshToken,
    expiresAt: typeof auth.expiresAt === 'number' ? auth.expiresAt : 0,
  }
}

/**
 * 按 domain 判定版本。
 *   workbuddy.ai 或 *.workbuddy.ai -> 国际版
 *   其它                            -> 国内版
 */
export function variantOf(domain) {
  const lowered = String(domain || '').trim().toLowerCase()
  if (lowered === 'workbuddy.ai' || lowered.endsWith('.workbuddy.ai')) return 'global'
  return 'cn'
}
