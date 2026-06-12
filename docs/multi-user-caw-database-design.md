# 多用户 CAW 与 Venice x402 数据库设计

更新日期: 2026-06-11

## 目标

本文档把项目从“单钱包 Demo”推进到“多用户、多 Agent、可审计支付链路”的方案收束成一个可开发的设计稿。

目标完整链路:

```text
Web 用户登录
  -> 使用 email 作为 MVP 身份锚点
  -> 为该 user 创建独立 CAW CLI HOME/profile
  -> CAW onboarding 创建 Agent Wallet
  -> CAW App pairing 把钱包所有权交给用户
  -> 用户创建并审批 venice_x402 Pact
  -> Agent 运行前检查 Venice 可消费余额
  -> 余额不足时创建 VeniceTopupOrder
  -> 使用该 user 自己的 CAW profile + active Pact 执行 x402 top-up
  -> 确认 Venice balance/canConsume 后恢复 AgentRun
  -> 所有状态、失败原因和账单记录按 user/agent 隔离
```

核心原则:

- 每个 Web 用户必须有独立 CAW wallet/profile/Pact，不能共享服务端默认 CAW profile。
- 所有 CAW CLI 调用都必须带当前登录用户的 `user.id`。
- `coboId` 在 MVP 中等于 normalized email，只作为身份锚点和唯一约束，不是钱包地址或支付凭证。
- 真实扣款必须同时满足全局 kill switch、用户/Agent 自动充值开关、active `venice_x402` Pact、Pact 限额和用户显式授权边界。
- x402 支付成功和 Venice 余额到账要分开记录；Agent 是否恢复以 Venice `canConsume` 或余额确认结果为准。

## 当前已有基础

当前 Prisma schema 已有这些核心模型:

- `User`: 登录用户，已有 `email`、`coboId`、`cawWalletId`、`cawWalletAddress`。
- `CawWalletOnboardingSession`: CAW CLI onboarding session 和 wallet bootstrapping 进度。
- `CawPairingSession`: CAW App pairing code 状态。
- `CawAuthorization`: Pact 授权记录，已有 `purpose=credits_payment | venice_x402`。
- `CreditAccount`、`LedgerEntry`、`TopupOrder`、`AgentUsageEvent`: 当前 credits/payment demo 账务基础。

当前代码已有这些实现方向:

- `lib/caw/cli.ts` 的 `runCawCli(userId, args)` 会把 CAW CLI HOME 隔离到 `.caw-cli-homes/<userId>`。
- `/api/wallet/caw/discover`、`/api/wallet/caw/pacts` 已开始按当前 user 调 CAW CLI。
- Venice x402 top-up 路径已要求 active `venice_x402` Pact，并通过用户级 CAW profile 执行。
- CAW onboarding 对 `wallet_bootstrapping / waiting_wallet_active / preparing` 已按等待状态展示，不再误判为失败。

当前缺口:

- CAW runtime credential 还没有产品化落库。
- 多 Agent 维度还没有一等模型。
- Venice top-up order 状态机还不够细，不能完整表达 payment settled 但 balance 未到账的中间态。
- Agent 暂停/恢复状态还没有持久化模型。
- 自动支付 heartbeat 需要从 demo user 改为扫描启用自动充值的 user/agent。

## 多用户隔离模型

### CAW CLI HOME 规则

每个用户一个独立 HOME:

```text
CAW_CLI_HOME_ROOT=.caw-cli-homes
userId=usr_7edf313831a24e49
HOME=.caw-cli-homes/usr_7edf313831a24e49
```

所有 CAW 操作都必须经过:

```ts
runCawCli(user.id, args)
```

禁止在多用户路径中直接使用:

```text
HOME=~/.cobo-agentic-wallet
spawn("caw", args)
caw wallet current   // without user-scoped HOME
```

### 用户间隔离验收

- A 用户 onboarding 只写 `.caw-cli-homes/<A>`。
- B 用户 onboarding 只写 `.caw-cli-homes/<B>`。
- A/B 的 `walletId`、`walletAddress`、`agentId`、Pact、top-up order 不能串。
- 后台 heartbeat 扫描时必须以 `userId + agentId` 为粒度加锁。
- 所有支付订单都必须带 `userId`，Agent 相关订单还必须带 `agentId` / `agentRunId`。

## 推荐数据库设计

下面是目标设计，不要求一次性全部迁移；可以按“用户级 CAW credential -> Agent -> VeniceTopupOrder -> AgentRun”的顺序逐步落地。

### User

当前已有，建议保留并强化唯一约束:

```prisma
model User {
  id                   String   @id
  email                String   @unique
  coboId               String?  @unique
  coboIdBoundAt        DateTime?
  cawWalletId          String?  @unique
  cawWalletAddress     String?  @unique
  createdAt            DateTime @default(now())

  cawOnboardingSession CawWalletOnboardingSession?
  pairingSession       CawPairingSession?
  cawRuntimeCredential CawRuntimeCredential?
  authorizations       CawAuthorization[]
  agents               Agent[]
  veniceTopupOrders    VeniceTopupOrder[]
  agentRuns            AgentRun[]

  @@map("users")
}
```

字段语义:

- `email`: Web 登录身份。
- `coboId`: MVP 默认等于 normalized email，后续可扩展为 Cobo 侧用户身份。
- `cawWalletId`: CAW wallet UUID。
- `cawWalletAddress`: EVM wallet address。

注意:

- `coboId` 不是支付凭证。
- `cawWalletAddress` 不足以执行支付；真实支付还需要 CAW runtime credential 和 active Pact。

### CawWalletOnboardingSession

当前已有，建议补齐进度字段和失败分类:

```prisma
model CawWalletOnboardingSession {
  userId            String              @id
  sessionId         String?
  status            CawOnboardingStatus
  phase             String?
  bootstrapStage    String?
  walletStatus      String?
  retryAfterSeconds Int?
  needsInput        Boolean             @default(false)
  prompts           Json?
  nextAction        String?
  lastError         String?
  failureType       String?
  agentName         String?
  apiUrl            String?
  walletId          String?
  walletName        String?
  agentId           String?
  createdAt         DateTime            @default(now())
  updatedAt         DateTime            @updatedAt
  user              User                @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@map("caw_wallet_onboarding_sessions")
}
```

状态建议:

```text
not_started
waiting_input
running
wallet_active
failed
```

特殊等待态:

```text
phase=wallet_bootstrapping
bootstrapStage=waiting_wallet_active
walletStatus=preparing
```

这个状态表示 CAW/Cobo 后端仍在生成钱包，不是前端按钮失败。

### CawRuntimeCredential

建议新增。它是多用户真实支付的关键表。

```prisma
model CawRuntimeCredential {
  id              String   @id
  userId          String   @unique
  walletId        String   @unique
  walletAddress   String   @unique
  walletName      String?
  agentId         String
  apiUrl          String
  apiKeyEncrypted String
  cawHomePath     String?
  keyVersion      Int      @default(1)
  lastVerifiedAt  DateTime?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  user            User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([agentId])
  @@map("caw_runtime_credentials")
}
```

字段语义:

- `apiKeyEncrypted`: CAW API key 加密后保存；绝不能明文返回前端。
- `cawHomePath`: 可选，只保存相对路径或逻辑路径，避免泄露本机绝对路径。
- `keyVersion`: 支持后续轮换加密密钥。
- `lastVerifiedAt`: 最近一次成功读取 CAW profile/status 的时间。

安全要求:

- API 响应不返回 `apiKeyEncrypted`。
- 日志不能打印明文 API key。
- `.caw-cli-homes/` 不能提交 git。
- 加密密钥通过部署环境变量或 KMS 管理，不写入数据库。

### CawPairingSession

当前已有，可补充 wallet metadata，便于用户在手机 App 输入前核对:

```prisma
model CawPairingSession {
  userId      String           @id
  code        String
  status      CawPairingStatus
  expiresAt   DateTime
  walletId    String?
  walletName  String?
  agentId     String?
  createdAt   DateTime         @default(now())
  updatedAt   DateTime         @updatedAt
  user        User             @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@map("caw_pairing_sessions")
}
```

状态:

```text
generated
paired
expired
```

规则:

- pairing code 必须来自 CAW CLI `caw wallet pair`，不能是 Web 随机生成。
- `pair-status` 只跟踪首次 pair token；钱包已 paired 后用 `caw status.wallet_paired` 兜底确认。

### CawAuthorization

当前已有，建议继续用 `purpose` 区分业务授权。

```prisma
model CawAuthorization {
  id                    String                  @id
  userId                String
  purpose               CawAuthorizationPurpose @default(credits_payment)
  walletAddress         String
  pactId                String
  pactApiKey            String?
  status                CawAuthorizationStatus
  singleLimitUsdcMinor  Int
  dailyLimitUsdcMinor   Int
  monthlyLimitUsdcMinor Int
  spentTodayUsdcMinor   Int                     @default(0)
  spentMonthUsdcMinor   Int                     @default(0)
  dailyWindowStart      DateTime
  monthlyWindowStart    DateTime
  expiresAt             DateTime
  createdAt             DateTime                @default(now())
  user                  User                    @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, purpose, createdAt])
  @@map("caw_authorizations")
}
```

目的类型:

```text
credits_payment  // 站内 credits demo 合约
venice_x402      // Venice x402 top-up
```

建议补充:

- `pactApiKey` 也应加密存储，或改为 `pactApiKeyEncrypted`。
- 同一 user/purpose 同一时间最多一个 active Pact。
- Pact refresh 必须读取当前用户 CAW profile，不能读全局 profile。

### Agent

建议新增。用于把自动充值开关、Venice 配置和 Agent 运行态从 User 拆出来。

```prisma
model Agent {
  id                         String   @id
  userId                     String
  name                       String
  provider                   String   @default("venice")
  veniceWalletAddress        String?
  autoTopupEnabled           Boolean  @default(false)
  balanceThresholdTokens     Decimal?
  topupAmountUsdcMinor       Int      @default(1000000)
  dailyBudgetUsdcMinor       Int      @default(20000000)
  monthlyBudgetUsdcMinor     Int      @default(100000000)
  maxConsecutiveFailures     Int      @default(3)
  consecutiveFailures        Int      @default(0)
  lastBalanceCheckedAt       DateTime?
  lastTopupOrderId           String?
  createdAt                  DateTime @default(now())
  updatedAt                  DateTime @updatedAt
  user                       User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  runs                       AgentRun[]
  veniceTopupOrders          VeniceTopupOrder[]

  @@unique([userId, name])
  @@index([userId])
  @@map("agents")
}
```

MVP 可以先用每个 user 一个默认 agent，后续再开放多 Agent。

### AgentRun

建议新增。用于余额不足时暂停并恢复 Agent。

```prisma
model AgentRun {
  id                  String         @id
  userId              String
  agentId             String
  externalRunId       String?
  status              AgentRunStatus
  prompt              String?
  pauseReason         String?
  veniceBalanceUsd    Decimal?
  lastTopupOrderId    String?
  startedAt           DateTime       @default(now())
  pausedAt            DateTime?
  resumedAt           DateTime?
  completedAt         DateTime?
  updatedAt           DateTime       @updatedAt
  user                User           @relation(fields: [userId], references: [id], onDelete: Cascade)
  agent               Agent          @relation(fields: [agentId], references: [id], onDelete: Cascade)

  @@index([userId, status])
  @@index([agentId, status])
  @@map("agent_runs")
}
```

状态:

```text
running
paused_waiting_balance
topup_in_progress
resumable
failed_requires_user_action
completed
```

### VeniceTopupOrder

建议新增或替换当前简化版 Venice order。它是防重复扣款和恢复 Agent 的中心表。

```prisma
model VeniceTopupOrder {
  id                       String                  @id
  userId                   String
  agentId                  String?
  agentRunId               String?
  triggerSource            VeniceTopupTriggerSource
  status                   VeniceTopupOrderStatus
  failureType              String?
  failureReason            String?
  walletId                 String?
  walletAddress            String?
  pactId                   String?
  usdAmount                Decimal?
  usdcMinor                Int
  balanceBeforeUsd         Decimal?
  balanceAfterUsd          Decimal?
  canConsumeBefore         Boolean?
  canConsumeAfter          Boolean?
  x402Network              String?
  x402Asset                String?
  x402PayTo                String?
  requestId                String                  @unique
  paymentTransaction       Json?
  paymentResponse          Json?
  httpStatus               Int?
  responseBodySnippet      String?
  stderrSnippet            String?
  retryCount               Int                     @default(0)
  lastAttemptAt            DateTime?
  balanceConfirmStartedAt  DateTime?
  balanceConfirmedAt       DateTime?
  expiresAt                DateTime?
  createdAt                DateTime                @default(now())
  updatedAt                DateTime                @updatedAt
  user                     User                    @relation(fields: [userId], references: [id], onDelete: Cascade)
  agent                    Agent?                  @relation(fields: [agentId], references: [id], onDelete: SetNull)

  @@index([userId, status])
  @@index([agentId, status])
  @@index([agentRunId])
  @@index([createdAt])
  @@map("venice_topup_orders")
}
```

触发来源:

```text
heartbeat
agent_run
manual
```

状态机:

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

关键规则:

- `requestId` 必须稳定且唯一，同一订单重试复用同一个 request id。
- 同一个 `userId + agentId` 同时只能有一个非终态 order。
- 支付提交成功后先进入 `payment_settled` 或 `balance_confirming`，不能直接认为 Agent 可以恢复。
- 只有确认 Venice `canConsume=true` 或余额达到阈值后，才进入 `balance_confirmed`。

Postgres 可以用 partial unique index 防重复:

```sql
CREATE UNIQUE INDEX venice_topup_one_active_order
ON venice_topup_orders ("userId", "agentId")
WHERE status IN (
  'created',
  'balance_checked',
  'payment_submitting',
  'payment_settled',
  'balance_confirming',
  'balance_confirmed',
  'agent_resuming'
);
```

Prisma schema 不能直接表达 partial index，需要放在 migration SQL 里。

### VeniceBalanceCheck

建议保留独立检查日志，便于运营和调试 heartbeat。

```prisma
model VeniceBalanceCheck {
  id                   String   @id
  userId               String
  agentId              String?
  status               String
  balanceUsd           Decimal?
  canConsume           Boolean?
  thresholdUsd         Decimal?
  topupAmountUsdcMinor Int
  reason               String
  error                String?
  topupOrderId         String?
  createdAt            DateTime @default(now())

  @@index([userId, createdAt])
  @@index([agentId, createdAt])
  @@map("venice_balance_checks")
}
```

## 关键流程设计

### 1. 登录和身份补齐

```text
requireCurrentUser()
  -> normalize email
  -> if user.coboId is null:
       set coboId=email
  -> return user
```

验收:

- 新用户首次登录后 `User.coboId=email`。
- 老用户 `coboId` 为空时下次访问自动补齐。
- 钱包/支付 API 未登录时返回 401。

### 2. CAW onboarding

```text
POST /api/wallet/caw/onboarding
  -> requireCurrentUser()
  -> runCawOnboard({ userId, sessionId, agentName, answers })
  -> upsert CawWalletOnboardingSession
  -> if wallet_active:
       readCawCliWalletProfile(userId)
       readCawProfileCredentials(userId)
       encrypt api key
       upsert CawRuntimeCredential
       update User.cawWalletId / User.cawWalletAddress
```

重要规则:

- 有 `sessionId` 后所有后续调用必须继续传同一个 `sessionId`。
- `wallet_status=preparing` 是等待态，不是失败。
- 不要在同一个用户上反复开新 session。

### 3. CAW App pairing

```text
POST /api/wallet/caw/pairing-code
  -> require wallet_active or CLI profile ready
  -> createCawCliPairingCode(user.id)
  -> save CawPairingSession(status=generated)

POST /api/wallet/caw/pairing-code/refresh
  -> getCawCliPairingStatus(user.id)
  -> if paired:
       mark paired
       refresh CawRuntimeCredential/User wallet fields
```

页面必须展示:

- pairing code
- wallet name
- agent name
- wallet UUID
- agent ID
- expiresAt

### 4. 创建 Venice Pact

```text
POST /api/venice/pact
  -> discover Venice x402 requirement
  -> build Pact scoped to Base USDC + Venice payTo
  -> submitCawCliPact(user.id, pact)
  -> save CawAuthorization(purpose=venice_x402, status=pending_user_approval)

POST /api/venice/pact/refresh
  -> showCawCliPact(user.id, pactId)
  -> if active:
       save status=active
       save/refresh pactApiKeyEncrypted if available
```

验收:

- 未审批 Pact 时不能自动支付。
- Pact 过期、撤销、超限时不能绕过。
- `credits_payment` Pact 不能用于 Venice x402。

### 5. Venice top-up

```text
ensureVeniceBalanceForAgentRun(userId, agentId, agentRunId)
  -> read Venice balance
  -> if canConsume:
       allow Agent run
  -> find or create active VeniceTopupOrder
  -> validate wallet + runtime credential + venice_x402 Pact
  -> dry-run/preflight when requested
  -> execute caw fetch x402 with user-scoped HOME
  -> mark payment_settled
  -> poll Venice balance
  -> mark balance_confirmed
  -> resume AgentRun
```

真实支付前置条件:

- `VENICE_AUTO_X402_TOPUP_ENABLED=1` 或手动显式确认。
- `Agent.autoTopupEnabled=true`，自动路径才允许。
- 用户 CAW wallet 已 active/paired。
- active `venice_x402` Pact 存在。
- Pact 单笔/日/月额度足够。
- CAW wallet 有足够 USDC 和 gas。
- x402 requirement network/asset/payTo 与 Pact 匹配。

## 防重复扣款

三层防护:

1. DB partial unique index: 同一 `userId + agentId` 只允许一个非终态 `VeniceTopupOrder`。
2. 进程内 lock: key 使用 `venice-topup:${userId}:${agentId}`。
3. 幂等 request id: 同一 order 重试必须复用同一个 `requestId`。

终态:

```text
succeeded
failed
expired
blocked_missing_wallet
blocked_missing_pact
blocked_pact_limit
```

非终态:

```text
created
balance_checked
payment_submitting
payment_settled
balance_confirming
balance_confirmed
agent_resuming
```

## API 路由改造清单

必须用户级 CAW HOME:

- `app/api/wallet/caw/onboarding/route.ts`
- `app/api/wallet/caw/pairing-code/route.ts`
- `app/api/wallet/caw/pairing-code/refresh/route.ts`
- `app/api/wallet/caw/discover/route.ts`
- `app/api/wallet/caw/pacts/route.ts`
- `app/api/wallet/caw/runtime-config/route.ts`
- `app/api/venice/pact/route.ts`
- `app/api/venice/pact/refresh/route.ts`
- `app/api/venice/sign-message/route.ts`
- `app/api/venice/x402-topup/route.ts`

应避免的实现:

- route 内直接读取 `~/.cobo-agentic-wallet`。
- route 内直接 `spawn("caw")`。
- 前端传入 `userId` 决定操作对象；必须从 session 取当前用户。
- 前端看到 API key、Pact API key 或本机 CAW profile 路径。

## 迁移顺序

推荐一段一段做，别一次把整张棋盘掀起来。

1. 补齐 `CawRuntimeCredential`，绑定成功后加密保存 CAW credential。
2. 强化 `CawWalletOnboardingSession` 和 `CawPairingSession` 的进度/metadata 字段。
3. 新增 `Agent`，先创建每个 user 的默认 agent。
4. 新增 `AgentRun`，实现余额不足暂停/恢复状态。
5. 新增完整版 `VeniceTopupOrder` 和 partial unique index。
6. heartbeat 从 demo user 改成扫描开启自动充值的 agents。
7. x402 执行入口改成 `ensureVeniceBalanceForAgentRun()`。
8. 增加 balance confirmation worker，支付成功后确认 Venice `canConsume` 再恢复 Agent。

## 验收标准

多用户:

- A 用户创建 CAW wallet 不影响 B 用户。
- A 用户 Pact 不会出现在 B 用户 dashboard。
- A 用户 top-up 使用 A 的 CAW HOME/profile。
- B 用户 top-up 使用 B 的 CAW HOME/profile。

钱包绑定:

- onboarding 中断后能通过 session id 继续。
- wallet active 后数据库有 wallet UUID、wallet address、agent ID、apiUrl。
- pairing code 是 CAW CLI 返回的真实 code。

支付安全:

- 没有 active `venice_x402` Pact 时不能自动扣款。
- Pact 超限或过期时不能自动扣款。
- 全局 kill switch 关闭时不能自动扣款。
- 连续点击或 heartbeat 重复触发不会产生多笔真实支付。

Agent 恢复:

- Venice 余额不足时 AgentRun 暂停。
- x402 支付成功但 Venice balance 未确认时 AgentRun 不恢复。
- Venice `canConsume=true` 后 AgentRun 标记为 resumable 或恢复执行。
- 失败原因能在 dashboard 上看到。

## 当前已知阻塞

- 当前 CAW onboarding session `sess-6083ccf87267cd4e` 的 wallet 仍处于 `preparing`，需要等待 Cobo/CAW 后端激活或联系 Cobo 支持。
- Venice wallet auth 需要 EIP-4361 / EIP-191 `personal_sign` 能力；CAW 是否支持仍需真实验证。
- 真实 x402 top-up 必须在 Pact active 且用户显式确认后执行，不能用 smoke test 误触发。

