# DSH WorkBuddy（多账号版）

把 **WorkBuddy / CodeBuddy 桌面端**里可用的模型接入 DeepSeek Harness，并在此基础上增加了：

- **多账号池**：同一个版本可保存多个账号，随时切换
- **导入 / 导出**：账号凭据可备份、迁移到别的机器
- **渠道校验规避**：处理上游对非官方客户端的启发式拦截

本项目 fork 自 [dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)（MIT，作者 corrinehu），原版逻辑完整保留，只在其上叠加上述能力。

> ⚠️ **与 connect 原版冲突**：两者注册同一个 provider id `workbuddy`，**不能同时安装**。

---

## 安装

**前置**：本机已安装并登录 WorkBuddy（国内版）或 WorkBuddy AI 桌面 App，或事先准备好账号凭据。

```sh
# Web profile（按实际内核固定版本）
dsh plugin --profile web add dsh-workbuddy-fnos-wenkbaby@0.2.2
dsh web
```

也可以从 GitHub 源码安装：

```sh
dsh plugin --profile web add github:Wenk12138baby/dsh-workbuddy-fnos-wenkbaby
```

### 版本兼容

| DSH 内核 | 本插件 |
|---|---|
| 0.2.1-rc.2 ～ 0.2.2-alpha.x | ✅ `>=0.2.1-rc.2 <0.3.0-0` |
| 0.3.0 及以上 | ❌ 未验证 |

`package.json` 用 `engines.dsh` 而不是 `peerDependencies` 声明兼容范围。原因：dsh 的兼容判定逻辑里，
**只要存在 `engines.dsh` 就单独用它判定，忽略全部 peer 依赖**；没有该字段时才会逐个检查
`@deepseek-ai/dsh-*` 的 peer 版本。原版把 peer 锁死在 `0.2.1-rc.2`，导致在 rc.5 上插件被静默跳过。

---

## 多账号

### 在界面里管理

侧栏 **插件** → 点 `dsh-workbuddy-fnos-wenkbaby` → 展开 **多账号管理（N）**。

每个版本（国内版 / 国际版）各有一个「当前」账号：

| 操作 | 说明 |
|---|---|
| 切换 | 把该账号设为当前版本的使用账号，模型列表随后刷新 |
| 删除 | 从账号池移除（当前账号被删时会自动顺延到同版本下一个） |
| 导出全部账号 | 下载 JSON（**含明文令牌**） |
| 导入 | 粘贴内容或选择文件 |

当前账号的按钮显示为「当前使用中」并禁用，其余为「切换」。

> 注意：**导入会把导入的账号设为该版本的当前账号**。如果只想入库、不想改变当前选择，导入后再点一次原来的账号「切换」即可。

### 存储

账号池文件：`$DSH_HOME/workbuddy-accounts.json`（权限 600）。

```json
{
  "version": 1,
  "active": { "cn": "<uid>", "ai": "<uid>" },
  "accounts": [
    {
      "variant": "cn",
      "uid": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "credential": {
        "accessToken": "...",
        "refreshToken": "...",
        "expiresAtMs": 1794989662372,
        "domain": "www.workbuddy.cn",
        "uid": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
        "nickname": "你的昵称",
        "enterpriseId": ""
      }
    }
  ]
}
```

首次读取时会自动迁移旧的单账号文件（`.workbuddy-auth.json` / `.workbuddy-ai-auth.json`），**旧文件保留不删**。

### 导出格式

```json
{
  "schema": "dsh-workbuddy-export/v1",
  "exportedAt": "2026-10-31T00:00:00.000Z",
  "accounts": [
    { "variant": "cn", "uid": "...", "nickname": "...", "domain": "...", "credential": { "accessToken": "...", "refreshToken": "...", "expiresAtMs": 0 } }
  ]
}
```

导入除了上面的导出格式，还接受：

- 裸数组 `[{ variant, credential }]`
- 单个 `{ credential: {...} }`（版本按 `domain` 推断：`*.workbuddy.ai` → 国际版，其余 → 国内版）
- WorkBuddy 桌面端的 `auth.info` 明文结构（`{ auth: {...}, account: {...} }`）

### ⚠️ 安全提醒

**导出的文件包含明文 accessToken / refreshToken。** 任何拿到它的人都能使用你的额度。
只在自有设备间传输，不要发到聊天群、网盘或任何公共位置。
如果泄露，请立即在对应桌面端重新登录以刷新令牌。

---

## 渠道校验规避

上游 `copilot.tencent.com` 会做启发式判定，命中时返回：

```json
{"code":11128,"msg":"Illegal API invocation from an unapproved channel",
 "displayMsg":{"zh":"请求被拦截，请重新发送"},
 "displayTips":{"zh":"这次调用没通过渠道校验，可能不是官方客户端发出的"}}
```

已定位并处理的触发点（`lib/sanitize.js`）：

| # | 触发条件 | 处理 |
|---|---|---|
| 1 | system 含 `You are an AI agent powered by` | → `You are an assistant powered by` |
| 2 | system 含 `You are a coding agent powered by` | → `You are a coding assistant powered by` |
| 3 | system 含 Web GUI / 浏览器描述 | → 换成 `the current interface` 等中性说法 |
| 4 | system 含 DSH 的路径规则段 | → 整段替换为一句中性说明 |
| 5 | 连续多条 `role:"user"` | 合并成一条（`\n\n` 连接） |

第 4 项值得说明：把 system prompt 按段落累加逐段测试，第 4 段一加入就命中 11128，
但**该段里每一句单独发送都能通过** —— 说明判定针对的是「整段特征组合」而非某个关键词，
所以按整段替换处理，而不是逐词打补丁。

**开关**：

```sh
WORKBUDDY_NO_SANITIZE=1   # 关闭全部清洗，行为回到未打补丁的原版
WORKBUDDY_DEBUG=1         # 把发出的请求体与上游错误写入 $TRIM_PKGVAR/workbuddy-debug.log
```

---

## HTTP API

前缀 `/plugins/dsh-workbuddy-fnos/accounts`：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 列出账号与激活状态 |
| POST | `/activate` | `{variant, uid}` 切换 |
| POST | `/remove` | `{variant, uid}` 删除 |
| POST | `/export` | 导出（含明文令牌） |
| POST | `/import` | 导入 |

---

## 已知问题

| 问题 | 说明 |
|---|---|
| 与 connect 原版冲突 | 同一个 provider id `workbuddy`，不能同时装 |
| 国际版 catalog 无计费 | connect 上游 `/console/enterprises/personal/models` 对 global 返回 500 |
| `app.sock` EACCES | 与本插件无关，属应用目录权限问题 |

---

## 开发

```
lib/
├── index.js                    host 半身（provider 注册、HTTP 路由）
├── client.js                   浏览器半身（插件配置页 UI）
├── host-heartbeat-*.js         核心逻辑（凭据、上游客户端、catalog）
├── accounts.js                 账号池存储
├── pool-store.js               store 包装层 + AccountManager
├── account-routes.js           HTTP API
└── sanitize.js                 渠道校验规避
```

改包名时：`lib/client.js` 第 2 行 `window.__ModuleLoader__.load({ id })` 的 `id`
**必须与 `package.json` 的 `name` 一致**，否则前端报 `loaded without registering`。
host 侧注册的路由前缀（`/plugins/dsh-workbuddy-connect/*`）不必同步改。

多账号卡片挂在 **`plugins.bundle.config`** 槽位上（并入 `WorkBuddyConfigPage`）。
DSH 0.1.6+ 一个 bundle 只有这一个配置入口，旧的 `settings.plugin.item` 槽位不再被声明，
挂上去的组件完全不渲染。

---

## 许可

MIT。原版 `dsh-workbuddy-connect` © corrinehu，见 [LICENSE](./LICENSE) 与
[THIRD_PARTY_NOTICES.txt](./THIRD_PARTY_NOTICES.txt)。
