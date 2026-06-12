# Wait Dev

更新日期: 2026-06-12

## 给下一位开发 agent 的背景

项目目标是做一个 Web 管理台，让用户把自己的 Cobo 钱包和运行在 OpenClaw / Hermes 上的 Agent 绑定起来。当 Venice token 余额不足时，系统通过 x402 自动向 Venice 支付并补充额度，让 Agent 不需要人工干预就能继续运行。

目标完整流程:

1. 用户打开 Web，用邮箱注册/登录。
2. 系统自动把登录邮箱作为当前 MVP 的 `coboId`，不再要求用户手动输入 Cobo ID。
3. Web 生成匹配码。
4. 用户在手机 Cobo App 输入匹配码完成匹配。
5. Web 显示 Cobo 钱包信息和授权状态。
6. 系统持续监控 Venice token 余额。
7. 余额不足时，通过 x402 自动向 Venice 支付。
8. 成功后 Venice token 额度补充，Agent 继续运行，管理台记录支付。
9. 失败时停止支付，管理台记录明确失败原因。

当前代码已有 demo 登录、CAW 绑定/状态、Venice x402 top-up 基础路径、heartbeat 余额轮询、支付锁、stale sweep 和管理台展示基础。当前还不是完整 MVP，下面按缺失流程列出开发方案。

## 2026-06-12 开发记录: 多用户 CAW credential 隔离

本次已经把核心后端 CAW SDK 执行链路从“进程级默认钱包”改为“当前登录用户的钱包/profile”:

- `lib/caw/gateway.ts`
  - `HttpCawGateway` 支持注入 `apiUrl` / `apiKey` / `walletId` / `walletAddress`。
  - 用户级 gateway 设置 `allowEnvFallback=false`，不会静默回退到 `AGENT_WALLET_WALLET_ID` / `CAW_WALLET_ID`。
- `lib/caw/cli.ts`
  - 新增 `readCawCliProfileCredentials(userId, walletUuid)`，从 `.caw-cli-homes/<userId>/.cobo-agentic-wallet/profiles/.../credentials` 读取当前用户 profile。
- `lib/domain/services.ts`
  - 新增用户级 gateway helper，统一从 `User.cawWalletId` / `User.cawWalletAddress`、`caw_runtime_credentials` 和用户隔离 CAW CLI profile 解析 CAW credential。
  - `createPairingCode` fallback、`connectCawWallet` fallback、`createCawAuthorization` fallback、`refreshCawAuthorization` fallback、`approveUsdcForCreditsPayment`、`requestTestTokens`、`refreshPendingTopupOrders`、`executeCreditsTopup`、`listCawTransactions` 都改为当前用户 gateway。
  - `getUserCawWalletId()` 不再用全局 env wallet id 兜底。
- `app/api/wallet/caw/transactions/route.ts`
  - 去掉 env wallet fallback，改为 `listCawTransactions({ userId })`。
- `app/api/venice/sign-message/route.ts`
  - runtime status 改为 `getCawIntegrationStatus(user.id)`，不再读无参默认 runtime。
- `lib/venice/topup.ts`
  - 已确认当前 x402 top-up 执行调用 `runCawFetchX402({ userId, ... })`，会使用用户隔离 CAW home。

验证结果:

- `npm run typecheck` 通过。
- `npm run lint` 通过，无 error；仍有项目既有 unused warning。

### 2026-06-12 追加修复: 多用户辅助入口隔离

在核心付款和交易链路之后，又补齐了几个会影响多用户隔离的辅助入口:

- `app/api/wallet/caw/discover/route.ts`
  - 已改为 `runCawCli(user.id, ["wallet", "list"])`，读取当前用户隔离 CAW home。
- `app/api/wallet/caw/pacts/route.ts`
  - 已改为 `runCawCli(user.id, ["pact", "list", ...])`，并用当前用户 DB 钱包信息返回 `boundWallet`。
- `app/api/wallet/caw/runtime-config/route.ts`
  - 已改为用户级兼容 route，不再写 `process.env.AGENT_WALLET_*`，也不再读全局 HOME。
  - `GET ?autobind=1` 从当前用户隔离 CAW profile 绑定钱包。
  - `POST` 通过 `connectCawWallet({ userId, cawWalletId })` 写当前用户 DB 绑定。
- Venice config/settings/logs
  - `app/api/config/venice/route.ts` 改为当前用户 API key/model。
  - `app/api/settings/route.ts` 改为当前用户 threshold，不再写 `process.env.VENICE_BALANCE_THRESHOLD`。
  - `app/api/venice/logs/route.ts` 只返回当前用户日志。
- BlockRun heartbeat
  - 全局钱包自动充值默认 fail-closed，避免用 `CAW_WALLET_ADDRESS` 串用户。
  - 如需旧 demo 行为，必须显式设置 `BLOCKRUN_ALLOW_GLOBAL_AUTOTOPUP=1`。

仍需后续生产加固:

- 用户级 Venice config 当前是进程内存 + env fallback，服务重启会丢失；正式产品应落库。
- `lib/caw/runtime-config-store.ts` 仍作为旧兼容模块存在，但普通业务 route 不应再依赖它。
- BlockRun heartbeat 的正式版本应扫描 DB 中开启自动充值的用户/Agent，而不是使用全局钱包兼容开关。

## 最新需求确认

### Cobo ID 的定位

当前 MVP 不再要求用户单独输入 Cobo ID。我们已经确认:

- `coboId` 不是支付凭证。
- `coboId` 不等于钱包地址。
- `coboId` 的主要作用是数据库里的 Cobo 用户身份锚点，用来做 Web 用户和 Cobo 侧用户身份绑定。
- MVP 阶段可以直接令 `User.coboId = User.email`。
- 一个 `coboId` 只允许绑定一个 Web 用户，主要用于唯一性约束、审计和后续 Cobo 侧查询扩展。

推荐数据关系:

```text
User
  id
  email unique
  coboId unique nullable    // MVP 默认等于 email
  cawWalletId unique nullable
  cawWalletAddress unique nullable
```

真正执行 x402 支付依赖的是:

- CAW wallet UUID / `cawWalletId`
- CAW wallet address / `cawWalletAddress`
- active `venice_x402` Pact
- CAW API key / runtime credentials
- Venice x402 challenge

因此后续开发应删除“用户手动输入 Cobo ID”这一步。用户注册/登录成功后，服务端自动写入或补齐 `coboId = normalizedEmail`。

### Web 生成匹配码如何匹配 CAW App

重要前提: Web 不能只在本地生成一个随机码，然后期待 CAW App 能识别。CAW App 能匹配这个码，必须满足以下条件之一:

1. 匹配码由 Cobo/CAW 官方服务端生成，Web 调 Cobo/CAW API 创建 pairing session，Cobo/CAW 返回 `pairingCode`。
2. 或者 Web 自己生成匹配码后，必须把这个匹配码登记到 Cobo/CAW 可查询的服务端系统里。
3. 手机 CAW App 输入匹配码后，App 必须能通过 Cobo/CAW 服务端查到这次 pairing session，并把确认结果回传给我们的 Web 后端，方式可以是 webhook、轮询查询、或 Cobo API 状态查询。

如果没有 Cobo/CAW 服务端参与，刚登录的 Web 用户确实没有任何 CAW 信息，无法单靠本地随机码匹配到手机 App。

所以正确实现路径不是“Web 本地生成码并等待”，而是:

```text
Web 用户登录
  -> 后端以 user.email / coboId 创建 pairing request
  -> 调 Cobo/CAW API 创建或登记 pairing session
  -> Cobo/CAW 返回 pairingCode + sessionId + expiresAt
  -> Web 展示 pairingCode
  -> 用户在 CAW App 输入 pairingCode
  -> CAW App 通过 Cobo/CAW 服务端确认
  -> Cobo/CAW 服务端通知我们的后端，或后端轮询 Cobo/CAW 查询结果
  -> 后端拿到 walletUuid / walletAddress / agentId / pact 信息
  -> 后端写入 User 和相关 wallet/session 表
```

如果目前拿不到 Cobo/CAW 官方 pairing API，则 MVP 只能保留 CLI/local profile demo 路径，不能宣称已经完成真实 CAW App 匹配闭环。

### 推荐 MVP 路径: 通过 CAW CLI 为每个用户创建/绑定钱包

当前最合理、最可落地的 MVP 路径是: Web 后端不要自己随机造匹配码，而是调用 CAW CLI 的 onboarding / wallet pair 能力，让 CAW CLI 去创建 Cobo/CAW 官方认可的 pairing code。用户在手机 CAW App 输入这个 code 后，CAW CLI profile 会得到对应的钱包信息。后端再把这个用户自己的 CAW profile 信息保存到数据库。

这条路径可以解决两个问题:

- 刚登录时 Web 不知道用户的 CAW 信息，但 CAW CLI 生成的 pairing code 能让手机 App 和 Cobo/CAW 后端完成配对。
- 每个 Web 用户使用独立 CAW CLI HOME/profile，后续就能区分不同用户的钱包、Pact 和 x402 支付凭证。

现有代码已经有一部分基础:

- `lib/caw/cli.ts` 的 `runCawCli(userId, args)` 会调用 `ensureCawHome(userId)`。
- 默认 CAW_HOME 根目录是项目下 `.caw-cli-homes/<userId>`，也可以用 `CAW_CLI_HOME_ROOT` 覆盖。
- 这意味着同一台机器上可以按 `userId` 隔离 CAW CLI profile，不必共用操作系统用户的默认 `~/.cobo-agentic-wallet`。

推荐 onboarding 流程:

```text
用户邮箱登录
  -> User.coboId = User.email
  -> 用户点击“连接 CAW 钱包”
  -> POST /api/wallet/caw/onboarding/start
  -> 后端创建 CawWalletOnboardingSession(status=started)
  -> 后端调用 runCawOnboard({ userId, agentName, apiUrl })
  -> 如果 CLI 返回 needsInput/prompts，前端展示需要用户补充的信息
  -> 后端调用 createCawCliPairingCode(userId)
  -> CAW CLI 返回 Cobo/CAW 可识别的 pairingCode/expiresAt
  -> Web 展示 pairingCode
  -> 用户在手机 CAW App 输入 pairingCode
  -> Web 轮询 GET /api/wallet/caw/pairing-code/status
  -> 后端调用 getCawCliPairingStatus(userId)
  -> 状态 paired/completed 后，后端调用 readCawCliWalletProfile(userId)
  -> 读取 walletId/walletAddress/walletName/agentId/apiUrl
  -> 加密读取并保存该 userId 对应 CAW credentials
  -> 更新 User.cawWalletId / User.cawWalletAddress
  -> 更新 onboarding session status=wallet_active
```

需要落库的数据:

```text
User
  id
  email
  coboId                 // MVP = email
  cawWalletId
  cawWalletAddress

CawWalletOnboardingSession
  id
  userId
  status                 // started / waiting_pairing / wallet_active / expired / failed
  sessionId
  pairingCode
  pairingExpiresAt
  walletId
  walletAddress
  walletName
  agentId
  apiUrl
  failureReason
  createdAt
  updatedAt

CawRuntimeCredential
  id
  userId
  walletId
  agentId
  apiUrl
  apiKeyEncrypted
  cawHomePath            // 可选，只保存相对或逻辑路径更好
  createdAt
  updatedAt
```

关键实现要求:

1. **每个用户必须有独立 CAW CLI HOME**
   - 使用 `runCawCli(userId, args)` 这类封装。
   - 不要在多用户流程里直接调用全局 `caw` 默认 profile。
   - 不要依赖当前机器的 `~/.cobo-agentic-wallet` active profile 作为正式用户数据源。

2. **所有 CAW CLI 调用都必须带 userId**
   - wallet current
   - wallet pair
   - wallet pair-status
   - pact submit/show/list
   - fetch x402
   - sign message
   - balance 查询

3. **绑定成功后必须落库**
   - `User.cawWalletId`
   - `User.cawWalletAddress`
   - `CawWalletOnboardingSession.wallet_active`
   - `CawRuntimeCredential.apiKeyEncrypted`
   - `agentId/apiUrl/walletName`

4. **后续 Venice x402 支付必须读取当前用户自己的 CAW profile**
   - 已完成: `runVeniceX402Topup()` 当前复用 `runCawFetchX402({ userId, pactId, ... })`。
   - `caw fetch` 会使用 `.caw-cli-homes/<userId>` 下的 profile。
   - 后续重点不再是执行 HOME 隔离，而是补齐订单状态、余额确认和失败归类。

5. **CAW pacts/discover/runtime-config 路由要逐步去掉全局 HOME 假设**
   - 当前部分 route 还读取真实 `HOME/.cobo-agentic-wallet`，这是 demo 路径。
   - MVP 多用户路径应改成基于 `user.id` 的 CAW_HOME。
   - `GET /api/wallet/caw/pacts` 应调用 `runCawCli(user.id, ["pact", "list", ...])`，而不是读取默认 active profile。

验收标准:

- A 用户登录后生成的 pairing code 只写入 A 用户的 onboarding session。
- B 用户登录后生成的 pairing code 使用 B 用户独立 CAW_HOME，不覆盖 A 用户 profile。
- A/B 用户分别完成手机 App 配对后，数据库里有各自不同的 `cawWalletId` / `cawWalletAddress`。
- A 用户创建的 Pact 不会出现在 B 用户管理台。
- A 用户触发 Venice x402 top-up 时，CLI 使用 A 用户的 CAW profile。
- B 用户触发 Venice x402 top-up 时，CLI 使用 B 用户的 CAW profile。

开发时优先改造这些文件:

- `lib/caw/cli.ts`: 保持所有 CLI 调用基于 `userId` 隔离 HOME。
- `app/api/wallet/caw/onboarding/route.ts`: start/continue onboarding。
- `app/api/wallet/caw/pairing-code/route.ts`: 调 `createCawCliPairingCode(user.id)`。
- `app/api/wallet/caw/pairing-code/status/route.ts`: 调 `getCawCliPairingStatus(user.id)`，成功后 `readCawCliWalletProfile(user.id)` 并落库。
- `app/api/wallet/caw/pacts/route.ts`: 改为使用当前用户 CAW_HOME，而不是默认 HOME。
- `lib/venice/topup.ts`: 已完成 x402 支付走 `runCawFetchX402(userId, ...)`，后续只需继续补订单状态和余额确认。

不建议的做法:

- 不要让用户手动上传 CAW API key 作为主流程。
- 不要把所有用户都绑定到同一个系统默认 CAW profile。
- 不要只保存 wallet address 而不保存 wallet UUID / agentId / apiUrl / encrypted credentials。
- 不要让前端直接调用 CAW CLI 或看到 CAW API key。

### 绑定后自动 Pact 免密支付的当前状态

用户完成 CAW App 绑定后，目标流程应该是:

```text
用户绑定 CAW App 成功
  -> 后端保存该用户的 CAW wallet/profile/credentials
  -> Web 引导用户创建 Venice x402 Pact
  -> 用户在 CAW App 审批 Pact
  -> 后端保存 active venice_x402 Pact
  -> heartbeat 按用户/Agent 监控 Venice token 余额
  -> 余额低于阈值
  -> 后端使用该用户自己的 CAW profile + active Pact 执行 caw fetch x402
  -> CAW 按 Pact 规则免密支付
  -> Venice token 余额补充
  -> 管理台记录订单和结果
```

当前代码还没有完整做到这个闭环，只是有雏形:

- 已有 Venice balance heartbeat: `lib/r34-sweep-heartbeat.ts`。
- 已有 x402 top-up 执行函数: `lib/venice/topup.ts`。
- x402 top-up 会要求 active `venice_x402` Pact。
- 有 payment lock，避免并发重复支付。
- 自动支付默认关闭，必须设置 `VENICE_AUTO_X402_TOPUP_ENABLED=1` 才会真实触发。

关键缺口:

1. **绑定 CAW App 成功后保存用户钱包/profile 尚未完整产品化**
   - 需要按上面的 CAW CLI onboarding 流程，把 `walletId`、`walletAddress`、`agentId`、`apiUrl`、encrypted credentials 落库。

2. **绑定后没有自动引导创建 Venice x402 Pact**
   - 现有代码有 Venice x402 authorization / pact preview / create 的基础，但还没有和“钱包绑定成功”串成强引导。
   - 绑定成功后，管理台应显示“创建 Venice 自动支付授权”步骤。
   - Pact 创建后用户需要在 CAW App 审批。
   - 审批完成后后端保存 `CawAuthorization(purpose=venice_x402, status=active)`。

3. **自动触发还不是多用户/多 Agent**
   - 当前 heartbeat 仍偏 demo user。
   - 需要改为扫描所有 `autoTopupEnabled=true` 且有 active `venice_x402` Pact 的用户/Agent。

4. **x402 执行已改成用户级 CAW profile**
   - `runVeniceX402Topup()` 已复用 `runCawFetchX402({ userId, pactId, ... })`。
   - 当前 CLI 会使用 `.caw-cli-homes/<userId>`。
   - 剩余工作是补齐订单状态、余额确认、失败归类和 heartbeat 多用户扫描。

5. **支付结果记录还不完整**
   - 当前还没有 Venice x402 独立订单模型。
   - 需要新增 `VeniceTopupOrder`，记录触发原因、余额前后、Pact、HTTP 状态、失败类型、超时状态。

6. **自动支付默认保护关闭**
   - 当前为了避免误扣款，必须显式配置 `VENICE_AUTO_X402_TOPUP_ENABLED=1`。
   - 正式 MVP 应改为全局 env 总开关 + 用户/Agent DB 开关双重控制。

实现绑定后自动免密支付闭环的开发顺序:

1. 完成 CAW CLI onboarding 多用户 profile 落库。
2. 绑定成功后强引导创建 `venice_x402` Pact。
3. 实现 Pact 审批状态轮询，保存 active authorization。
4. 新增 `VeniceTopupOrder`。
5. 已完成: `runVeniceX402Topup()` 改为用户级 `runCawFetchX402()`。
6. heartbeat 改为扫描启用自动充值的用户/Agent。
7. 余额不足时创建订单并执行 x402。
8. 成功后刷新 Venice balance，失败时记录结构化原因。

验收标准:

- 用户 A 绑定 CAW App 后，只能使用 A 的 wallet/Pact 自动支付。
- 用户 B 绑定 CAW App 后，只能使用 B 的 wallet/Pact 自动支付。
- 用户未创建或未审批 `venice_x402` Pact 时，余额不足不会自动扣款，只记录“缺少授权”。
- 用户已审批 `venice_x402` Pact 且开启自动充值后，余额不足会自动执行 x402 支付。
- 支付成功后能在管理台看到订单成功和 Venice 余额更新。
- 支付失败、CAW 拒绝、审批超时、钱包余额不足都会在管理台看到明确原因。

### Venice 在本项目里的定义

产品决策: Venice 是 Agent 运行时调用的外部 AI 推理服务。Agent 执行任务时会调用 Venice API，消耗 Venice 的 spendable balance。余额不足时，我们的系统用用户绑定的 CAW wallet，通过 x402 top-up 补充 Venice 余额。

Venice 支持的关键能力:

- AI 推理 API: chat、responses、image、audio、video、embeddings 等。
- 传统 API key / Bearer token 调用。
- x402 wallet auth / x402 payment flow。
- x402 balance 查询，用于判断某个 wallet 是否还能继续消费。

在本项目中需要关心的 Venice balance 字段:

- `canConsume`: 是否还能继续调用付费 API。
- `balanceUsd`: 当前可消费余额。
- `minimumTopUpUsd`: 最低充值金额。
- `suggestedTopUpUsd`: 推荐充值金额。
- `diemBalanceUsd`: Venice 侧额外额度或奖励余额，具体业务语义后续联调确认。

产品含义:

```text
Agent 要执行任务
  -> 我们先检查 Venice balance / canConsume
  -> canConsume=true 且余额足够: Agent 正常执行
  -> 余额不足: Agent 保留上下文并暂停
  -> 系统尝试 x402 自动充值
  -> 充值成功: Agent 恢复执行
  -> 充值失败或超过 Pact 限制: Agent 不继续执行，提示用户处理
```

后续开发注意:

- 不要把 Venice 简化成“普通钱包余额”。它是 Agent 调用 AI 服务的可消费额度。
- 余额单位、字段名、充值金额需要以后按 Venice x402 API 的真实响应校准。
- 当前文档采用 `balanceUsd` / `canConsume` 作为产品语义，具体接口字段以 Venice 官方 API 联调为准。

### Venice x402 wallet auth 调研结论和阻塞项

产品主路径确认: Agent 调 Venice paid inference API 时，应该消耗用户 CAW wallet 对应的 Venice x402 spendable balance，而不是消耗一个全局 Venice API key 的余额。这样 CAW Pact 免密 top-up 才能和 Agent 消耗余额对上。

Venice 官方要求:

- Paid inference routes 支持 wallet auth。
- Header 名称: `X-Sign-In-With-X`。
- EVM wallet auth 需要签 EIP-4361 SIWE message。
- Header value 是 base64 JSON。

Venice 期望的 payload 形状:

```json
{
  "address": "0x...",
  "message": "SIWE prepared message",
  "signature": "0x...",
  "timestamp": 1234567890,
  "chainId": 8453
}
```

调用形态:

```http
GET /api/v1/x402/balance/{walletAddress}
X-Sign-In-With-X: <base64-json>

POST /api/v1/chat/completions
X-Sign-In-With-X: <base64-json>
```

余额不足时，Venice paid route 会返回 `402 Payment Required`。top-up 路径是:

```http
POST /api/v1/x402/top-up
```

关键风险:

- 当前代码 `lib/venice/siwe.ts` 走的是 EIP-712 typed data。
- Venice 文档要求的是 EIP-4361 SIWE message，也就是 EIP-191 / `personal_sign` / `signMessage(message)` 风格。
- 当前代码注释里也写了 CAW CLI 不支持 `personal_sign`，因此目前实现不能认为已经兼容 Venice。

必须验证的 CAW 能力:

```bash
caw schema tx sign-message
caw tx sign-message --help
```

需要确认 CAW CLI/API 是否支持以下任一能力:

- `personal_sign`
- EIP-191 raw message signing
- SIWE message signing
- 对任意 UTF-8 message 做 EVM compatible `signMessage`

如果 CAW 支持 EIP-191/SIWE:

1. 重写 `lib/venice/siwe.ts`。
2. 生成标准 EIP-4361 SIWE message。
3. 通过用户自己的 CAW profile 调 `caw tx sign-message`。
4. 得到 signature。
5. base64 encode `{ address, message, signature, timestamp, chainId }`。
6. 在 Venice balance 和 chat/completions 调用中使用 `X-Sign-In-With-X`。

如果 CAW 只支持 EIP-712，不支持 EIP-191:

- CAW wallet 可能无法直接用于 Venice wallet auth。
- CAW 仍可用于 x402 top-up，但 Agent 调 Venice paid API 的 wallet auth 会缺签名能力。
- 需要联系 Cobo/CAW 确认是否可以支持 EIP-191/SIWE signing。
- 或者产品上需要临时 fallback 到 Venice API key，但这会导致 CAW top-up 和 Agent 消耗余额不一定属于同一账户体系，不能作为最终闭环。

后续 agent 开发前必须先处理此阻塞项。不要在未验证 CAW EIP-191/SIWE 签名能力前宣称“CAW wallet auth 调 Venice 已完成”。

### 自动支付关闭策略

产品决策: Web 端先做“系统侧关闭自动支付”，不负责直接撤销 CAW App 里的 Pact。

含义:

- 用户在 Web 管理台关闭自动支付后，我们的后端不再触发 Venice x402 自动充值。
- 但是用户之前在 CAW App 审批过的 Pact 仍可能保持 active。
- Web 界面必须明确提示: 如果用户想彻底撤销钱包授权，需要去 CAW App 里关闭或撤销对应 Pact。

需要实现:

```text
AgentSettings / RuntimeSetting
  autoTopupEnabled: boolean
```

自动支付判断:

```text
if agent.autoTopupEnabled !== true:
  不触发 x402 自动充值

if active venice_x402 Pact 不存在:
  不触发 x402 自动充值

if globalAutoPayEnabled !== true:
  不触发 x402 自动充值
```

管理台展示:

- 自动支付: 开启/关闭。
- Pact 状态: active / pending / expired / revoked。
- 提示文案: “关闭 Web 自动支付只会阻止本系统继续发起自动充值；如需撤销钱包授权，请到 CAW App 中撤销 Pact。”

### Pact 默认授权策略

产品决策: Pact 策略由 Web 界面让用户决定，再由用户在 CAW App 里确认。MVP 提供默认值，用户可修改。

默认值:

- 单笔上限: 5 USDC
- 每日上限: 20 USDC
- 每月上限: 100 USDC
- 有效期: 7 天
- 允许对象: Venice x402 top-up
- 网络: Base / USDC

开发要求:

- Web 表单展示默认值。
- 用户可调整默认值。
- 后端按用户选择生成 `venice_x402` Pact。
- Pact 提交后状态为 pending，必须等 CAW App 审批后才能自动支付。
- 如果 Pact limit 不足以覆盖本次 top-up，系统不得继续运行 Agent，也不得尝试绕过限制。

验收标准:

- 用户可以看到默认 Pact 限额。
- 用户可以修改限额并提交。
- 未审批 Pact 时不会自动支付。
- Pact 超限时 Agent 暂停并提示用户提高限额或重新创建 Pact。

### Agent 暂停和恢复策略

产品决策: Agent 余额不足时应保留上下文并暂停，不应在没有余额时继续执行。上下文由 OpenClaw/Hermes 和我们系统两边保存。

分工:

- OpenClaw/Hermes 保存完整 Agent 上下文。
- 我们系统保存最小运行状态:
  - `runId`
  - `agentId`
  - `userId`
  - `status`
  - `pauseReason`
  - `veniceBalanceUsd`
  - `lastTopupOrderId`
  - `updatedAt`

建议状态:

```text
AgentRun
  running
  paused_waiting_balance
  topup_in_progress
  resumable
  failed_requires_user_action
  completed
```

流程:

```text
用户在 Web 输入任务
  -> 创建 AgentRun(status=running)
  -> 执行前检查 Venice canConsume / balance
  -> 余额足够: 调用 Agent / Venice
  -> 余额不足: AgentRun(status=paused_waiting_balance)
  -> 创建 VeniceTopupOrder
  -> 自动充值中: AgentRun(status=topup_in_progress)
  -> 充值成功: AgentRun(status=resumable)，通知或允许 Agent 恢复
  -> 充值失败: AgentRun(status=failed_requires_user_action)，展示失败原因
```

验收标准:

- 余额不足时 Agent 不继续调用 Venice。
- 自动充值成功后 Agent 能从原 run/context 恢复。
- Pact 超限、Pact 失效、支付失败时 Agent 不恢复，管理台提示用户处理。

### 管理台主页范围

产品决策: 用户登录后的主页不是单纯设置页，而是 Agent 使用主界面 + 账单/钱包/授权状态。

主页需要包含:

- Agent 运行入口: 用户输入任务，例如“让 Agent 去查什么”，Agent 执行并返回。
- Venice 余额 / canConsume 状态。
- 使用账单。
- Venice 充值记录。
- CAW App 绑定状态。
- `venice_x402` Pact 信息:
  - 状态
  - 单笔/每日/月度限额
  - 有效期
  - 是否需要用户在 CAW App 审批
- 自动支付开关状态。
- 支付记录和失败原因。

状态提示原则:

- 钱包未绑定: 明确提示用户先绑定 CAW App。
- Pact 未创建: 提示创建 Venice 自动支付 Pact。
- Pact 待审批: 提示去 CAW App 审批。
- Pact 过期或撤销: 提示重新创建或恢复授权。
- 余额不足且自动充值关闭: 提示开启自动充值或手动充值。
- 自动充值失败: 展示失败类型和下一步操作。

### 防重复扣款方案

产品决策: 接受三层防重复扣款方案。

三层方案:

1. DB 层订单约束
   - 同一个 user/agent 同一时间只能有一个 processing 的 `VeniceTopupOrder`。
   - heartbeat 发现已有 processing order 时跳过，不创建新支付。

2. 进程内 lock
   - 同一 Node.js 进程内用内存 lock 防止重复点击、重复 heartbeat tick。
   - lock key 应从全局单 lock 改为 `userId + agentId` 维度。

3. 幂等 id
   - 每次 top-up 使用稳定 `orderId/requestId`。
   - 重试同一订单时复用同一个 id，不新建支付请求。

验收标准:

- 用户连续点击充值不会创建多笔真实支付。
- heartbeat 连续触发不会创建多笔真实支付。
- 服务重启后，如果已有 processing order，新 heartbeat 不会立刻重复扣款。
- 支付状态未知时优先查询/恢复订单，不直接发起新支付。

### 全局 kill switch

产品决策: 需要全局 kill switch。它不是用户日常开关，而是系统管理员/运营层面的紧急总开关。

作用:

- 发现 Venice API 异常时，立即停止所有自动充值。
- 发现 heartbeat 或订单逻辑可能重复扣款时，立即停止所有自动充值。
- 发现 CAW/x402 集成风险时，立即停止所有自动充值。
- 运维需要临时暂停金钱相关自动操作时，立即停止所有自动充值。

推荐两层开关:

```text
globalAutoPayEnabled
  系统全局总开关，由 env 或管理员设置控制

agent.autoTopupEnabled
  用户/Agent 自己的自动充值开关
```

判断逻辑:

```text
if globalAutoPayEnabled !== true:
  不允许任何自动支付

if agent.autoTopupEnabled !== true:
  不允许该 Agent 自动支付

if active venice_x402 Pact 不存在:
  不允许自动支付
```

建议实现:

- env 总开关: `VENICE_AUTO_X402_TOPUP_ENABLED=1`
- DB 用户/Agent 开关: `autoTopupEnabled=true`
- 两者必须同时开启才允许自动 x402 支付。

管理台文案:

- 如果全局 kill switch 关闭，用户开关仍可显示，但自动支付状态应提示“系统自动支付暂停中”。
- 用户无需理解 kill switch 细节，只需要知道当前系统不会自动扣款。

### VeniceTopupOrder 状态机

产品决策: heartbeat 自动触发、Agent 执行前触发、用户手动点击充值，先都走同一个 top-up 执行入口。后续如果真实业务需要，再按触发来源拆分策略。

核心原则:

- “x402 付款/结算成功”和“Venice 余额到账”必须拆开记录。
- Agent 是否恢复运行，以 Venice balance / `canConsume` 确认为准，不只看 x402 HTTP 2xx。
- 同一个 user/agent 同一时间只允许一个 active top-up order。
- 重试复用原订单，不新建独立订单，避免重复扣款和记录割裂。

建议状态:

```text
created
balance_checked
blocked_missing_wallet
blocked_missing_pact
blocked_pact_limit
payment_submitting
payment_settled
balance_confirming
balance_confirmed
agent_resuming
succeeded
failed
expired
```

状态含义:

- `created`: 创建订单，尚未检查余额或支付前置条件。
- `balance_checked`: 已确认 Venice 余额不足，需要充值。
- `blocked_missing_wallet`: 用户还没有绑定 CAW wallet。
- `blocked_missing_pact`: 用户还没有 active `venice_x402` Pact。
- `blocked_pact_limit`: Pact 存在但额度、有效期或策略不足以覆盖本次 top-up。
- `payment_submitting`: 正在调用 CAW/x402 执行支付。
- `payment_settled`: x402/CAW/facilitator 支付或结算已经成功，记录 HTTP 2xx、transaction、payment response 等。
- `balance_confirming`: 支付成功后，正在等待 Venice balance 更新。
- `balance_confirmed`: Venice balance 已确认足够，或 `canConsume=true`。
- `agent_resuming`: 系统正在让暂停的 AgentRun 恢复。
- `succeeded`: 余额确认完成，相关 AgentRun 已恢复或无需恢复，订单闭环结束。
- `failed`: 支付失败、网络错误、Venice 拒绝、CAW 拒绝、钱包余额不足等。
- `expired`: 等待用户审批或等待余额到账超过允许时间。

建议字段:

```text
VeniceTopupOrder
  id
  userId
  agentId
  agentRunId
  triggerSource          // heartbeat / agent_run / manual
  status
  failureType
  failureReason
  walletId
  walletAddress
  pactId
  usdAmount
  usdcMinor
  balanceBeforeUsd
  balanceAfterUsd
  canConsumeBefore
  canConsumeAfter
  x402Network
  x402PayTo
  requestId
  paymentTransaction
  paymentResponse
  httpStatus
  responseBodySnippet
  stderrSnippet
  retryCount
  lastAttemptAt
  balanceConfirmStartedAt
  balanceConfirmedAt
  expiresAt
  createdAt
  updatedAt
```

触发入口:

```text
ensureVeniceBalanceForAgentRun(userId, agentId, agentRunId)
  -> 查询 Venice balance
  -> 余额足够: 返回 canRun=true
  -> 余额不足: 查找或创建 active VeniceTopupOrder
  -> 如果订单已经 payment_settled/balance_confirming: 不再支付，只继续查余额
  -> 如果订单 created/balance_checked 且前置条件满足: 执行 x402
  -> 如果订单 blocked/failed: 返回 requires_user_action
```

余额确认窗口:

- x402 支付成功后进入 `balance_confirming`。
- 在 5 分钟内周期性查询 Venice balance。
- 如果 `canConsume=true` 或余额达到阈值，进入 `balance_confirmed`。
- 然后进入 `agent_resuming`，恢复关联的 AgentRun。
- 恢复成功后进入 `succeeded`。
- 如果 5 分钟后仍无可用余额，订单进入 `expired` 或 `failed`，failureType 使用 `balance_confirm_timeout`，AgentRun 保持暂停并提示用户。

AgentRun 联动:

```text
AgentRun running
  -> 余额不足
  -> paused_waiting_balance
  -> 关联 VeniceTopupOrder
  -> topup_in_progress
  -> balance_confirmed
  -> resumable
  -> running / completed
```

失败联动:

- `blocked_missing_wallet`: AgentRun 进入 `failed_requires_user_action`，提示绑定 CAW App。
- `blocked_missing_pact`: AgentRun 进入 `failed_requires_user_action`，提示创建并审批 Pact。
- `blocked_pact_limit`: AgentRun 进入 `failed_requires_user_action`，提示提高 Pact 限额或重新创建 Pact。
- `payment failed`: AgentRun 保持暂停或进入 `failed_requires_user_action`，展示失败原因。
- `balance_confirm_timeout`: AgentRun 保持暂停，提示支付可能成功但 Venice 余额未到账，需要用户检查。

防重复扣款规则:

1. DB 层同一 `userId + agentId` 只能存在一个 active top-up order:
   - active 状态包括 `created`、`balance_checked`、`payment_submitting`、`payment_settled`、`balance_confirming`、`balance_confirmed`、`agent_resuming`。
2. 如果 heartbeat 和手动点击同时触发，必须复用同一个 active order。
3. 如果订单处于 `payment_settled` 或 `balance_confirming`，禁止再次发起 x402 支付，只允许继续确认余额。
4. retry 复用原订单:
   - 增加 `retryCount`。
   - 更新 `lastAttemptAt`。
   - 保留原始 `requestId` 或保存 `retryGroupId`。
5. 状态未知时先查询订单/余额/CAW 状态，不直接创建新支付。

验收标准:

- 付款成功但 Venice balance 未到账时，订单停在 `balance_confirming`，Agent 不恢复。
- Venice balance 到账后，订单进入 `balance_confirmed`，Agent 自动恢复。
- 5 分钟内未到账，订单记录 `balance_confirm_timeout`，Agent 继续暂停。
- 手动充值和 heartbeat 同时触发时只产生一笔支付。
- 重试不会创建新的独立订单。
- Pact 超限不会继续运行 Agent，也不会绕过 Pact 发起支付。

## 1. 真实用户注册和登录

### 目标

替换 demo 登录，让每个用户有真实账号、独立 session、独立钱包配置、独立 Venice 配置和独立支付记录。

### 当前现状

- 代码里已有 `requireCurrentUser()` 和登录页面基础。
- 当前仍偏 demo user 模型，很多逻辑默认使用 `DEMO_USER_ID`。
- 用户数据隔离还不完整。

### 开发步骤

1. 设计用户登录方式。MVP 推荐邮箱 magic link 或邮箱验证码，不要先做复杂密码体系。
2. 扩展 Prisma schema:
   - `User.email`
   - `User.emailVerifiedAt`
   - `LoginCode` 或 `MagicLinkToken`
   - `Session`
3. 实现接口:
   - `POST /api/auth/register-or-login/start`: 输入邮箱，生成验证码或 magic link。
   - `POST /api/auth/register-or-login/verify`: 校验验证码，创建 session。
   - `POST /api/auth/logout`: 清 session。
   - `GET /api/auth/me`: 返回当前用户。
4. 用户创建或首次登录成功后，自动设置 `coboId = normalizedEmail`。不要再让用户手动输入 Cobo ID。
5. 修改 `requireCurrentUser()`，禁止 fallback 到 demo user。
6. 扫描所有 `DEMO_USER_ID` 使用点，改成当前登录用户或后台任务里的明确 user/agent 查询。
7. 管理台登录后只展示当前用户自己的 Cobo/Venice/支付数据。

### 验收标准

- 新邮箱首次登录会创建用户。
- 已注册邮箱再次登录会复用同一个用户。
- 用户创建后 `coboId` 自动等于 normalized email。
- UI 不再出现手动输入 Cobo ID 的必填步骤。
- 未登录访问管理台 API 返回 401。
- A 用户看不到 B 用户的钱包、Pact、余额、支付记录。
- `npm run typecheck` 通过。

### 注意事项

- 不要把邮箱验证码或 magic link token 明文长期保存。至少保存 hash 和过期时间。
- session cookie 需要 `httpOnly`、`sameSite=lax`，生产环境加 `secure`。

## 2. Cobo ID 和手机 App 绑定闭环

### 目标

用户用邮箱登录后，系统自动以邮箱作为 `coboId` 创建 Cobo/CAW pairing request；Web 展示 Cobo/CAW 服务端返回的匹配码；用户在手机 CAW App 输入匹配码；Web 能确认绑定成功并展示 Cobo 钱包信息。

### 当前现状

- 已有 Cobo ID 绑定入口。
- 已有 CAW pairing code、onboarding、status、authorization 相关接口。
- 有 CAW CLI profile discovery/runtime config，适合本地 demo，不适合正式生产闭环。
- 目前还没有确认 Cobo/CAW 官方 pairing API 的创建、查询、回调协议。
- 因为刚登录时系统不知道用户的 CAW wallet 信息，真实匹配必须依赖 Cobo/CAW 服务端返回 wallet/profile 结果。

### 开发步骤

1. 删除或弱化手动 Cobo ID 输入 UI。后端统一使用当前登录用户的 `user.coboId`，MVP 中它等于登录邮箱。
2. 明确 Cobo/CAW App 配对协议:
   - Web 后端如何向 Cobo/CAW 创建 pairing session。
   - 创建 pairing session 需要哪些字段: `coboId/email`、app id、redirect/callback、过期时间等。
   - Cobo/CAW 返回哪些字段: `pairingCode`、`sessionId`、`expiresAt`。
   - 手机 App 输入匹配码后，后端如何收到结果: webhook、轮询、或 Cobo API 查询。
   - 成功结果里包含哪些 wallet/profile/agent 信息: `walletUuid`、`walletAddress`、`agentId`、`apiUrl`、Pact 信息等。
3. 正确的匹配码生成方式:
   - 优先调用 Cobo/CAW API 创建 pairing session，由 Cobo/CAW 返回可被 App 识别的匹配码。
   - 如果必须由 Web 生成匹配码，则必须同时把匹配码登记到 Cobo/CAW 服务端，否则手机 App 无法识别。
   - 禁止只在本地数据库生成随机码后就宣称可被 CAW App 匹配。
4. 设计绑定状态机:
   - `not_started`
   - `pairing_code_created`
   - `waiting_mobile_confirmation`
   - `wallet_bound`
   - `expired`
   - `failed`
5. 扩展或复用 `CawPairingSession` / `CawWalletOnboardingSession`:
   - `userId`
   - `coboId`
   - `pairingSessionId`
   - `pairingCode`
   - `expiresAt`
   - `status`
   - `walletUuid`
   - `walletAddress`
   - `agentId`
   - `failureReason`
6. 实现接口:
   - `POST /api/wallet/caw/pairing-code`: 生成匹配码，落库。
   - `GET /api/wallet/caw/pairing-code/status`: Web 轮询绑定状态。
   - `POST /api/webhooks/cobo/pairing`: 接收 Cobo App 确认结果，如果 Cobo 支持 webhook。
7. 修改 `POST /api/wallet/caw/pairing-code` 的职责:
   - 读取当前登录用户。
   - 确保 `user.coboId` 存在，不存在则写入 `user.email`。
   - 调 Cobo/CAW API 创建 pairing session。
   - 保存 Cobo/CAW 返回的 `sessionId`、`pairingCode`、`expiresAt`。
   - 返回给前端展示。
8. 成功后更新当前用户:
   - `cawWalletId`
   - `cawWalletAddress`
   - `coboId`
   - `cawAgentId`
9. 管理台展示:
   - Cobo ID，也就是当前邮箱
   - 钱包地址
   - wallet UUID
   - 绑定时间
   - 当前 Pact 状态

### 验收标准

- Web 生成匹配码后能看到倒计时和等待状态。
- 匹配码来自 Cobo/CAW 服务端，或已经登记到 Cobo/CAW 服务端，手机 App 能识别。
- 手机 App 完成输入后，Web 状态自动变成绑定成功。
- 匹配码过期后不能继续绑定。
- 同一个 Cobo wallet 不能绑定到两个用户。
- 绑定成功后刷新页面仍能看到钱包信息。

### 注意事项

- 当前 `runtime-config` 读取本机 `~/.cobo-agentic-wallet` 只适合本地 demo。正式流程需要从 Cobo API / webhook 结果落库。
- 匹配码要短时有效，避免被重复使用。
- 如果 Cobo/CAW 没有提供 pairing API 或 webhook，下一位 agent 必须先确认替代方案；不能假设 Web 本地码天然能被手机 App 识别。

## 3. 配置落库

### 目标

把现在存在内存或环境变量里的运行配置持久化，支持重启后恢复，支持按用户/Agent 隔离。

### 当前现状

- `lib/config/store.ts` 和 `lib/caw/runtime-config-store.ts` 主要使用内存 store。
- `app/api/settings/route.ts` 使用 `globalThis.__AUTOPAY_SETTINGS__`。
- `VENICE_BALANCE_THRESHOLD` 可以在进程内更新，但重启丢失。

### 开发步骤

1. 新增 Prisma 表 `RuntimeSetting`:
   - `id`
   - `userId`
   - `agentId` 可选
   - `key`
   - `value`
   - `createdAt`
   - `updatedAt`
2. 新增 Prisma 表或字段保存 CAW runtime config:
   - `walletUuid`
   - `walletName`
   - `apiUrl`
   - `agentId`
   - `apiKeyEncrypted`
3. 替换内存配置读写:
   - Venice API key
   - Venice model
   - low balance threshold
   - default top-up amount
   - auto top-up enabled
   - bound CAW runtime config
4. 敏感字段加密:
   - `VENICE_API_KEY`
   - `AGENT_WALLET_API_KEY`
5. 保留 env fallback:
   - 本地开发和 emergency override 仍可使用 env。
   - 优先级建议: DB user setting > env > default。

### 验收标准

- 修改阈值后重启服务仍保留。
- 关闭自动充值后重启仍关闭。
- 每个用户看到自己的配置。
- API key 不以明文出现在普通 API response。

### 注意事项

- 不要把 API key 存在 `globalThis` 作为正式数据源。
- API response 只返回 masked key，比如 `ven_***abcd`。

## 4. Venice x402 独立订单模型

### 目标

把 Venice x402 自动充值变成可追踪订单，而不是复用 inference log。订单要记录从触发、支付、成功、失败、超时的完整状态。

### 当前现状

- `runVeniceX402Topup()` 会调用 `caw fetch` 并写 inference log。
- top-up order 现有模型主要服务 credits payment，不完全等同 Venice x402。
- 失败原因还不够结构化。

### 开发步骤

1. 新增表 `VeniceTopupOrder`，字段建议:
   - `id`
   - `userId`
   - `agentId`
   - `walletAddress`
   - `pactId`
   - `status`
   - `triggerReason`
   - `usdAmount`
   - `usdcMinor`
   - `veniceBalanceBefore`
   - `veniceBalanceAfter`
   - `x402Network`
   - `x402PayTo`
   - `cawRequestId`
   - `httpStatus`
   - `responseBody`
   - `stderr`
   - `failureType`
   - `failureReason`
   - `startedAt`
   - `completedAt`
   - `createdAt`
   - `updatedAt`
2. 状态枚举建议:
   - `created`
   - `balance_checked`
   - `payment_submitting`
   - `caw_submitted`
   - `venice_confirmed`
   - `failed`
   - `approval_expired`
3. 修改 `runVeniceX402Topup()`:
   - 入参增加 `orderId` 或内部创建订单。
   - 执行前记录订单。
   - 解析 HTTP status 后更新订单。
   - 成功后刷新 Venice balance 并写 `veniceBalanceAfter`。
4. 修改管理台:
   - 新增 Venice top-up order 列表。
   - 展示成功/失败/超时原因。
5. 修改 heartbeat:
   - 余额不足时先创建订单，再调用支付。
   - payment lock 和订单状态要一致。

### 验收标准

- 每一次自动充值都有一条订单。
- 成功订单能看到金额、钱包、Pact、HTTP 状态、余额前后。
- 失败订单能看到失败类型和原始错误摘要。
- 审批超时订单最终变成 `approval_expired`。

### 注意事项

- responseBody/stderr 只保存截断后的内容，避免日志过大或泄露敏感数据。
- 订单状态更新要幂等，避免 heartbeat 重试造成重复支付。

## 5. 多用户和多 Agent 调度

### 目标

heartbeat 不再只服务 demo user，而是扫描所有启用自动充值的 Agent/user，分别检查 Venice 余额并触发 x402。

### 当前现状

- `lib/r34-sweep-heartbeat.ts` 仍使用 `DEMO_USER_ID`。
- `VENICE_AUTO_X402_TOPUP_ENABLED=1` 是全局开关。
- 缺少 Agent 实体和 Agent 级配置。

### 开发步骤

1. 新增或明确 `Agent` 表:
   - `id`
   - `userId`
   - `name`
   - `runtime`
   - `status`
   - `veniceWalletAddress`
   - `autoTopupEnabled`
   - `lowBalanceThresholdUsd`
   - `defaultTopupUsd`
2. Repository 增加查询:
   - `listAutoTopupAgents()`
   - `getAgentRuntimeSettings(agentId)`
3. heartbeat 流程改成:
   - 查询所有 `autoTopupEnabled=true` 的 active Agent。
   - 对每个 Agent 检查 Venice balance。
   - 每个 Agent 独立 lock，不能用全局单 lock。
   - 余额不足时创建 VeniceTopupOrder 并支付。
4. 防重复策略:
   - 同一个 Agent 同一时间只允许一个 processing order。
   - 如果已有 processing order，跳过本轮。
5. 管理台:
   - Agent 列表。
   - 每个 Agent 的余额、阈值、自动充值开关、最近订单。

### 验收标准

- 两个用户互不影响。
- 同一用户多个 Agent 可以各自配置阈值。
- 单个 Agent 不会并发重复充值。
- 关闭某个 Agent 自动充值后，heartbeat 不再为它支付。

### 注意事项

- 全局 `VENICE_AUTO_X402_TOPUP_ENABLED` 可保留为总开关，但生产逻辑必须以 DB 中 Agent 开关为准。
- lock 建议放内存 + DB 双层。内存防本进程并发，DB 防多实例并发。

## 6. 成功后 Venice 余额确认

### 目标

x402 支付成功后，系统确认 Venice token/余额已经补充，并把充值前后余额写入订单和管理台。

### 当前现状

- `refreshVeniceBalance()` 能查 billing balance，失败时尝试 x402 wallet balance。
- `runVeniceX402Topup()` 成功后没有强制刷新余额并写入正式订单。

### 开发步骤

1. 支付前调用 `refreshVeniceBalance()`，记录 `balanceBefore`。
2. `caw fetch` 返回 2xx 后，等待短暂确认窗口:
   - 立即查一次。
   - 如果没变化，延迟 3-5 秒再查一次。
   - 最多重试 3 次。
3. 写订单:
   - `veniceBalanceBefore`
   - `veniceBalanceAfter`
   - `balanceConfirmedAt`
4. 如果支付 2xx 但余额未变化:
   - 状态可设为 `venice_confirm_pending` 或 `failed_balance_not_updated`。
   - MVP 推荐先记录为 warning，不要重复支付。
5. 管理台展示余额变化。

### 验收标准

- 成功支付记录能看到充值前余额和充值后余额。
- 2xx 但余额未变化时不会立刻重复支付。
- 用户能在管理台看到“支付成功但余额确认延迟”的状态。

### 注意事项

- Venice API 可能异步记账，不能因为第一次余额没变就重复扣款。
- 余额字段单位要统一，文案里明确 USD/token/credit 的含义。

## 7. 失败路径产品化

### 目标

失败时管理台能清楚说明发生了什么，而不是只显示 raw error。

### 当前现状

- 有基础 error message 和 logs。
- 缺少统一 failure type。

### 开发步骤

1. 定义 `VeniceTopupFailureType`:
   - `venice_x402_rejected`
   - `caw_policy_rejected`
   - `cobo_approval_timeout`
   - `wallet_insufficient_funds`
   - `network_error`
   - `invalid_pact`
   - `balance_check_failed`
   - `unknown`
2. 写错误归类函数:
   - 输入 `httpStatus`、stdout、stderr、exception。
   - 输出 `failureType` 和面向用户的 `failureReason`。
3. 在 `runVeniceX402Topup()` catch 和非 2xx 分支调用归类函数。
4. 管理台展示:
   - 失败类型。
   - 简短原因。
   - 技术详情折叠展示。
5. stale sweep:
   - Cobo 审批超时统一标记 `cobo_approval_timeout`。

### 验收标准

- x402 直接失败显示 Venice 返回原因。
- CAW policy 拒绝显示 Pact/策略问题。
- 钱包余额不足显示需要充值钱包。
- 审批超时显示 Cobo 审批超时。
- 网络错误不会被误判成用户拒绝。

### 注意事项

- raw stderr 可能包含敏感信息，展示前需要截断和脱敏。

## 8. OpenClaw / Hermes Agent 对接

### 目标

让外部 Agent 能知道 Venice token 是否可用，余额不足时是否正在充值，充值完成后是否可以继续运行。

### 当前现状

- 当前主要是 Web 管理台和后台 heartbeat。
- 没有面向 Agent runtime 的清晰 API contract。

### 开发步骤

1. 定义 Agent runtime API:
   - `GET /api/agent/runtime/status`
   - `POST /api/agent/runtime/heartbeat`
   - `POST /api/agent/runtime/usage`
2. status 返回:
   - `agentId`
   - `veniceBalanceUsd`
   - `canRun`
   - `autoTopupEnabled`
   - `topupInProgress`
   - `lastTopupStatus`
   - `recommendedAction`
3. Agent 启动或执行任务前调用 status:
   - `canRun=true`: 正常执行。
   - `topupInProgress=true`: 等待或降级。
   - `canRun=false`: 暂停并提示管理台处理。
4. Agent 使用量上报:
   - 记录 Venice token 消耗趋势。
   - 帮助后台更早触发充值。
5. 认证:
   - 每个 Agent 配独立 API key 或 signed token。
   - 不要复用用户 Web session。

### 验收标准

- Agent 能查询当前是否可运行。
- 自动充值进行中时 Agent 不会盲目继续消耗失败。
- 充值成功后 Agent status 变为可运行。
- 未授权 Agent 不能访问其他 Agent 状态。

### 注意事项

- OpenClaw / Hermes 的适配层不要耦合 Web session。
- Agent API key 需要可轮换。

## 9. 管理台记录完善

### 目标

管理台要成为 MVP 阶段的主要可观测入口，用户能看到绑定状态、余额、自动支付开关、支付记录和失败原因。

### 当前现状

- Dashboard 已有多块基础 UI。
- 信息还分散，demo 文案和调试字段较多。

### 开发步骤

1. 首页概览:
   - Cobo 绑定状态。
   - Venice 当前余额。
   - 自动充值开关。
   - 最近一次支付状态。
   - Agent 是否可运行。
2. 设置页:
   - Venice API key。
   - 余额阈值。
   - 默认充值金额。
   - 自动充值启停。
   - Cobo wallet/Pact 状态。
3. 支付记录页:
   - 时间。
   - Agent。
   - 金额。
   - 状态。
   - 失败原因。
   - 详情。
4. Pact 状态提示:
   - 未创建 Pact。
   - Pact 待审批。
   - Pact 已过期。
   - Pact 限额不足。
5. 移除或折叠调试信息:
   - raw stdout。
   - caw path。
   - API key tail 只在必要时显示。

### 验收标准

- 用户不看日志也能知道系统是否正常。
- 失败后用户能知道下一步应该做什么。
- 余额阈值和自动充值开关修改后能持久保存。

### 注意事项

- MVP 不做邮件/推送，但管理台必须能查失败。
- UI 文案避免暴露内部实现细节。

## 10. 通知事件预留

### 目标

MVP 不实现邮件/消息推送，但支付失败、审批超时、余额持续不足等事件需要可被后续通知系统消费。

### 当前现状

- 没有统一 notification event。

### 开发步骤

1. 新增 `NotificationEvent` 表:
   - `id`
   - `userId`
   - `agentId`
   - `type`
   - `severity`
   - `title`
   - `message`
   - `metadata`
   - `status`
   - `createdAt`
2. 在关键流程写事件:
   - x402 支付失败。
   - Cobo 审批超时。
   - 钱包余额不足。
   - Pact 过期。
   - 自动充值被关闭但余额不足。
3. 管理台先展示事件列表。
4. 后续再接邮件/消息推送 worker。

### 验收标准

- 每个关键失败至少生成一条事件。
- 事件能在管理台看到。
- 后续接通知时不需要重构业务流程。

## 推荐开发顺序

1. 先做用户级 CAW CLI onboarding 和 wallet/profile 落库。
2. 同步验证 CAW 是否支持 Venice 需要的 EIP-4361 / EIP-191 SIWE 签名。
3. 再做配置落库。
4. 再做 Venice x402 独立订单模型。
5. 再做用户级 Venice x402 Pact 创建、审批状态轮询和保存。
6. 再做 AgentRun + Venice wallet-auth 调用。
7. 再做多用户/多 Agent 自动充值调度。
8. 最后整理管理台和通知事件。

这个顺序的原因: 现在最大不确定性不是订单表，而是“每个用户能否独立绑定 CAW App 并拿到可用于 Venice 的 wallet/profile/signing 能力”。如果 CAW 不能签 Venice 要求的 SIWE/EIP-191 message，则后续自动充值闭环要调整。因此下一位 agent 应先打通用户级 CAW 绑定和签名能力验证，再开发订单和自动扣款。

## 下一次 agent 开始前应先检查

1. `git status --short --branch`
2. `npm run typecheck`
3. `project-process.md`
4. 本文档 `wait_dev.md`
5. 当前是否允许真实联调。默认不要触发真实 x402 支付，除非明确设置 `VENICE_AUTO_X402_TOPUP_ENABLED=1` 并得到确认。

## 下一位 Agent 执行步骤

### 执行原则

- 先做开发和静态验证，不启动真实自动扣款。
- 不要默认使用全局 `~/.cobo-agentic-wallet` profile。
- 所有 CAW CLI 调用必须按当前 `userId` 使用独立 CAW_HOME。
- 没有明确允许前，不执行真实 Venice x402 top-up。
- 不要宣称 Venice wallet auth 已完成，除非 CAW EIP-191/SIWE 签名能力已经实测通过。

### 第 0 步: 环境和现状检查

1. 运行:
   ```bash
   git status --short --branch
   npm run typecheck
   ```
2. 阅读:
   - `project-process.md`
   - `wait_dev.md`
   - `lib/caw/cli.ts`
   - `lib/venice/siwe.ts`
   - `lib/venice/topup.ts`
3. 确认本地是否有 CAW CLI:
   ```bash
   which caw
   caw --help
   ```
4. 如果本地没有 CAW CLI，只做代码改造和 mock/static 验证；把真实 CLI 验证列为阻塞项。

### 第 1 步: 用户登录后自动设置 coboId=email

目标:

- 删除或弱化“用户手动输入 Cobo ID”的产品步骤。
- 用户创建或首次登录后，自动设置 `User.coboId = normalizedEmail`。

开发点:

1. 检查 `lib/auth/session.ts` 和登录 API。
2. 在用户创建或获取用户时补齐 `coboId`。
3. 确保 `coboId` unique，且同一个 email 对应同一个 user。
4. 管理台不再把 Cobo ID 作为用户必填输入。

验收:

- 新用户登录后数据库中 `coboId=email`。
- 老用户如果 `coboId` 为空，登录后自动补齐。
- 未登录访问涉及金钱或钱包的 API 返回 401 或跳登录。

### 第 2 步: 用户级 CAW CLI HOME/profile

目标:

- 每个 Web 用户拥有独立 CAW CLI HOME。
- A 用户和 B 用户的钱包、Pact、profile 不能串。

开发点:

1. 复用或强化 `lib/caw/cli.ts` 的 `runCawCli(userId, args)`。
2. 确认 CAW_HOME 路径:
   ```text
   .caw-cli-homes/<sanitized-userId>
   ```
3. 所有 CAW CLI 调用都必须从当前登录用户拿 `user.id`。
4. 把仍使用全局 HOME 的 route 标记或改造:
   - `app/api/wallet/caw/discover/route.ts`
   - `app/api/wallet/caw/pacts/route.ts`
   - `app/api/wallet/caw/runtime-config/route.ts`

验收:

- A 用户生成 pairing code 时只写 A 的 CAW_HOME。
- B 用户生成 pairing code 时只写 B 的 CAW_HOME。
- pact list/status 不读取全局 default profile。

### 第 3 步: CAW App pairing code onboarding

目标:

- Web 后端调用 CAW CLI 生成 CAW App 可识别的 pairing code。
- 用户在手机 CAW App 输入后，Web 能轮询到绑定成功。

开发点:

1. 调 `runCawOnboard({ userId, agentName, apiUrl })` 创建 onboarding session。
2. 调 `createCawCliPairingCode(userId)` 获取 pairing code。
3. `POST /api/wallet/caw/pairing-code` 必须:
   - `requireCurrentUser()`
   - 确保 `user.coboId = user.email`
   - 用 `user.id` 调 CAW CLI
   - 保存 `pairingCode`、`expiresAt`、`status=waiting_pairing`
4. `GET /api/wallet/caw/pairing-code/status` 必须:
   - 用 `user.id` 调 `getCawCliPairingStatus(user.id)`
   - 如果 paired/completed，调用 `readCawCliWalletProfile(user.id)`
   - 保存 wallet/profile 信息。

验收:

- pairing code 不是 Web 随机码，而是 CAW CLI 返回的码。
- pairing session 过期后状态变为 expired。
- pairing 成功后用户记录有 `cawWalletId` 和 `cawWalletAddress`。

### 第 4 步: CAW wallet/profile/credentials 落库

目标:

- 绑定成功后，数据库持久化当前用户 CAW wallet 和 runtime credential。

建议新增或完善:

```text
CawRuntimeCredential
  id
  userId
  walletId
  walletAddress
  walletName
  agentId
  apiUrl
  apiKeyEncrypted
  cawHomePath
  createdAt
  updatedAt
```

开发点:

1. 读取用户 CAW_HOME 下的 profile credentials。
2. 加密保存 API key，不明文返回前端。
3. 更新 `User.cawWalletId`、`User.cawWalletAddress`。
4. 更新 `CawWalletOnboardingSession.status=wallet_active`。

验收:

- 重启服务后仍能看到用户绑定的钱包。
- API response 只返回 masked key 或不返回 key。
- 同一个 wallet 不能绑定两个用户。

### 第 5 步: 验证 CAW 是否支持 Venice SIWE/EIP-191 签名

目标:

- 确认 CAW wallet 能否生成 Venice `X-Sign-In-With-X` 需要的签名。

必须执行或记录阻塞:

```bash
caw schema tx sign-message
caw tx sign-message --help
```

需要确认是否支持:

- `personal_sign`
- EIP-191 raw message signing
- SIWE message signing
- 任意 UTF-8 message 的 EVM compatible `signMessage`

如果支持:

1. 重写 `lib/venice/siwe.ts`。
2. 生成 EIP-4361 SIWE message。
3. 用当前用户 CAW profile 签名。
4. 生成 base64 JSON:
   ```json
   {
     "address": "0x...",
     "message": "...",
     "signature": "0x...",
     "timestamp": 1234567890,
     "chainId": 8453
   }
   ```
5. 用该 header 调 Venice x402 balance 做最小验证。

如果不支持:

- 明确记录阻塞。
- 不继续实现“CAW wallet auth 调 Venice”。
- 保留 Venice API key 作为开发 fallback，但标注它不是最终闭环。

### 第 6 步: 不做真实自动扣款，只准备后续接口

本阶段不要实现或开启真实自动扣款。只做以下准备:

1. 保留 `VENICE_AUTO_X402_TOPUP_ENABLED` 默认关闭。
2. 确认所有真实 top-up API 都有显式确认和登录校验。
3. 确认 x402 top-up 后续会走当前用户 CAW profile，而不是默认 profile。

### 第 7 步: 静态验证和交付

1. 跑:
   ```bash
   npm run typecheck
   git diff --check
   ```
2. 更新 `wait_dev.md` 中实际完成项和阻塞项。
3. 提交前确认没有加入:
   - `node_modules`
   - `.caw-cli-homes`
   - 真实 credentials
   - 本机 CAW profile
4. 提交说明建议:
   ```text
   implement user scoped caw onboarding
   ```
