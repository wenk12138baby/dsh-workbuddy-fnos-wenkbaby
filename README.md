# dsh-workbuddy-fnos-wenkbaby

把 **WorkBuddy / CodeBuddy** 的模型接进 DeepSeek Harness，支持**国际版**与**国内版**双账号。

专为 **fnOS / Linux** 设计，同时兼容 Windows / macOS。

作者：**温克Baby**

---

## 安装

```bash
# Web profile（图形界面）
dsh plugin --profile web add dsh-workbuddy-fnos-wenkbaby

# 或者无界面环境
dsh plugin --profile headless add dsh-workbuddy-fnos-wenkbaby
```

装完**重启 DSH**，然后打开 设置 → **WorkBuddy 接入**。

> 重启是必须的：只刷新页面不会加载新的插件 bundle。

---

## 两种接入方式

### 方式一：本机有 WorkBuddy（零配置）

插件自动找到 WorkBuddy 客户端，读取并解密本机凭据，**装上就能用**。

适用于：装过 WorkBuddy 桌面端并已登录的电脑。

### 方式二：本机没有 WorkBuddy（导入）

在一台有 WorkBuddy 的电脑上：

1. 装本插件 → 设置 → WorkBuddy 接入 → **导出凭据**
2. 得到 `workbuddy-export.json`

在没有 WorkBuddy 的机器上（如 fnOS）：

3. 装本插件 → 设置 → WorkBuddy 接入 → **粘贴或选择那个 JSON** → 导入
4. 完成

> ⚠️ **导出的文件包含明文访问令牌。** 任何拿到它的人都能使用你的 WorkBuddy 额度。
> 请只在自己的设备间传输，**不要**发送给他人或上传到网盘、聊天群、代码仓库。

---

## 功能

| 功能 | 说明 |
|---|---|
| 动态模型目录 | 从上游 `/v3/config` 实时拉取（实测 37 个模型），缓存 10 分钟 |
| 计费标注 | 模型名后附倍率与促销标签，例如 `GLM-5.1 · ×0.79`、`Hy3 · 免费 · 限时免费` |
| 手动刷新 | 设置页「刷新模型目录」按钮，强制重新拉取 |
| 双版本共存 | 国际版与国内版各占一个路由，额度独立 |
| 流式对话 | 支持 reasoning 内容与工具调用 |
| 多轮对话 | 自动合并连续 user 消息，符合上游对话结构 |

---

## 两种版本的区别

插件会按账号域名自动分流，两个版本可以同时存在。

| | 国际版 | 国内版 |
|---|---|---|
| 凭据域名 | `www.workbuddy.ai` | `www.workbuddy.cn` |
| 上游端点 | `www.workbuddy.ai` | `copilot.tencent.com` |
| 模型分组 | WorkBuddy（国际版） | CodeBuddy（国内版） |
| 额度 | 独立 | 独立 |

---

## 常见问题

### 提示「请求未通过渠道校验」（CHANNEL_REJECTED）

上游会对请求做启发式判定，实测确认的触发点有三个，插件都已自动处理：

| 触发条件 | 插件的处理 |
|---|---|
| system prompt 含 agent 身份声明（`You are an AI agent...`） | 改写为 `assistant` |
| system prompt 含「Agent 操作浏览器」类描述（`Web GUI` / `this GUI` / `browser ... DOM`） | 改写为中性表述 |
| 连续多条 user 消息 | 合并为一条 |

如果仍出现，说明上游更新了判定规则，请带上诊断日志反馈。

### 提示「参数被模型提供商拒绝」（11133 / `tools[0].function.name`）

上游不接受 OpenAI 的 `{type:"function", function:{...}}` 工具包装，需要扁平结构。
插件已按扁平格式发送。若仍出现，检查是否有其他插件改写了请求。

### 提示「凭据已失效」

token 有有效期（国际版约 1 年，国内版约 1 个月）。在安装 WorkBuddy 的机器上重新导出并导入即可。

### 提示「当前模型触发频率限制」

上游按模型限流，通常 1–3 分钟后自动恢复。也可以切换到其他模型。

### 模型列表为空或数量不对

在设置页点「刷新模型目录」。若仍为空，检查账号是否有效。

---

## 安全说明

- 凭据只保存在 DSH home 下的私有目录（`$DSH_HOME/workbuddy-fnos/`），文件权限 `0600`
- 插件不向任何第三方服务器发送数据，所有请求直达 WorkBuddy 官方端点
- 插件不修改系统文件
- 日志中不出现任何 token；诊断日志需显式设置 `DSH_WORKBUDDY_DEBUG=1` 才启用，
  且只记录请求形状（模型名、消息条数、角色、长度），不记录对话正文

---

## 技术实现

### 三层密钥体系（逆向自官方客户端）

```
第 1 层  atRestSecretKey
        WorkBuddy 二进制自己的 native 绑定生成：
        process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()
        该密钥对同一份二进制是确定性的（删掉用户目录也不变）。

第 2 层  protector key = sha256(atRestSecretKey)
        解开 auth.info 里 token 字段的 AES-256-GCM envelope。

第 3 层  可选：用 protector key 解开 keyblob 的 wrapped 槽（framing=file），
        得到 master key。凭据字段本身不需要这一层。
```

### AAD 构造（sym-v1）

```
"WB-AAD\0" + [1] + lp("WBEV1") + lp("sym-v1") + u32(suite)
          + lp(keyId) + [framingCode] + [0] + [0]
```

`lp()` = 4 字节大端长度 + UTF-8 字节。

### 必需请求头

```
Authorization: Bearer <token>
X-Conversation-ID / X-Conversation-Request-ID / X-Conversation-Message-ID
X-IDE-Type: WorkBuddy  X-IDE-Name: WorkBuddy  X-IDE-Version   X-Product: SaaS
X-User-Id  X-Domain  X-No-Enterprise-Id: 1  X-Requested-With: XMLHttpRequest
Origin / Referer（国际版 = workbuddy.ai，国内版 = codebuddy.cn）
```

### 端点

| 用途 | 路径 |
|---|---|
| 对话 | `POST /v2/chat/completions`（stream） |
| 模型清单 | `GET /v3/config` → `data.models` |
| 计费标注 | `GET /console/enterprises/personal/models` → `credits` / `tags` |
| 官方安装包 | `GET /v2/update?platform=workbuddy-linux-x64-deb` |

### 插件自身的 HTTP 接口

| 路径 | 方法 | 用途 |
|---|---|---|
| `/api/workbuddy-fnos/status` | GET | 账号、二进制、平台信息 |
| `/api/workbuddy-fnos/import-local` | POST | 从本机 WorkBuddy 读取并导入 |
| `/api/workbuddy-fnos/import` | POST | 导入导出的 JSON |
| `/api/workbuddy-fnos/export` | POST | 导出当前账号 |
| `/api/workbuddy-fnos/refresh-catalog` | POST | 强制刷新模型目录 |
| `/api/workbuddy-fnos/download-info` | GET | 查询官方 Linux 包地址 |
| `/api/workbuddy-fnos/remove` | POST | 删除单个账号 |
| `/api/workbuddy-fnos/clear` | POST | 清空全部账号 |

---

## 目录结构

```
lib/
  index.js      插件入口：注册 adapter、挂载设置页 API、自动读取本机凭据
  adapter.js    LlmAdapter 实现：listModels / resolveModel / prepareCall / stream
  catalog.js    模型目录与计费标注（/v3/config + console catalog）
  upstream.js   二进制探测、密钥读取、请求头、SSE 解析、错误分类
  crypto.js     三层密钥与 AAD 构造
  sanitize.js   上游渠道校验规避（agent 身份词、浏览器描述）
  store.js      凭据存储与导入导出
  client.js     设置页 UI（ModuleLoader 格式）
```

---

## 许可证

MIT
