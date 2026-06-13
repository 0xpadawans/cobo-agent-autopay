# Cobo Agent Autopay

**AI Agent 自动支付基础设施** — 基于 Cobo Agentic Wallet + x402 协议，让 AI Agent 具备自主支付能力。

---

## 项目背景

我们正在进入一个新时代——AI Agent 不只是思考，它们还会行动、花钱，并且很快，会自己赚钱。

今天的 AI 基础设施是为人类设计的：你充值，Agent 消耗，钱用完了，一切停止。有人得去发现这件事，有人得去补钱，Agent 在一旁等待。

这是错误的模型。

如果一个 AI Agent 有足够的自主性来做决策，它就应该有足够的自主性来管理自己的资源。它不应该因为钱包余额归零而停摆，不应该等待人类发现问题，它应该自己处理——就像处理其他一切事务一样：自动执行，在既定边界内，不中断地运行。

cobo-agent-autopay 是我们对这个问题的回答。

### 愿景：一个自给自足的 Agent 经济体

我们相信，AI Agent 的下一个前沿不只是任务执行——而是经济自主。一个完整的 Agent 经济体需要四个角色协同运作：

| 角色 | Agent | 职责 |
|------|-------|------|
| 💸 花钱 | Spender Agent | 消耗 AI 算力，执行任务，驱动产出 |
| 🏦 管钱 | Treasury Agent | 监控余额，自动补充，维持流动性 |
| 📈 赚钱 | Earner Agent | 通过 DeFi、套利或链上策略产生收益 |
| 🎯 调度 | Controller Agent | 统筹整个生态的资金流转 |

当四个角色全部就位，一个真正全新的东西就出现了：一个能为自身运营提供资金、能自主赚取收入、能管理自己金库的 AI Agent——人类负责制定规则，而不是拉动每一根控制杆。

### 我们现在在哪里

这个项目实现了前两个角色：**Spender** 和 **Treasury**。

Spender Agent 消耗 Venice.ai 的推理积分来驱动 AI 任务。Treasury Agent 监控 Spender 的钱包余额，当资金不足时自动转账 USDC 补充——触发这一切的不是人，而是系统本身，由 Cobo Pact 策略授权，在 Base 主网上执行。

这是真实运行中的 Agent to Agent 支付。不是演示可能性，而是正在发生的系统。

整个支付流程完全运行在 **Cobo Agentic Wallet（CAW）** 基础设施内：60 秒心跳轮询监控余额，余额不足触发 x402 协议向 Venice 充值，当钱包本身需要补充时，第二个 Agent 介入——授权到位、额度受限、全程自动。

没有私钥暴露，没有人工干预，没有单点故障。

### 为什么这件事重要

自主 AI Agent 的瓶颈从来都不是智能，而是基础设施：谁来支付算力费用？谁来补充钱包？谁来执行支出限额？

我们正在构建这个金融层，让 Agent 能够自己回答这些问题——这样部署 Agent 的人类，就可以专注于他们真正想让 Agent 去做的事情。

Earner Agent 和 Controller Agent 是下一步。当一个 Agent 既能花钱也能赚钱，当 Controller 能在整个系统中智能调度资金，闭环就完成了。这个经济体将真正实现自给自足。

这是我们的方向，这里是起点。

## 核心功能

### 1. 自动充值（Auto Top-up）

心跳每 60 秒轮询 Venice AI / BlockRun 余额，低于阈值时自动触发 x402 支付：

```
Agent 调用付费 API → 积分不足 → 心跳检测 → CAW 钱包支付 USDC → Venice/BlockRun 到账 → 继续运行
```

### 2. Treasury 双钱包互充

当 Spending 钱包 USDC 不足导致 x402 支付失败时，Treasury 钱包自动发起链上转账补充：

```
Spending USDC 不足 → 触发 Treasury 转账 → caw tx transfer → Spending 余额恢复 → 重试 x402 支付
```

Treasury API Key 使用 AES-256-GCM 加密存储，密钥从 `NEXTAUTH_SECRET` SHA-256 派生。

### 3. CAW 钱包管理

- **手机配对**：生成一次性配对码，用户在 Cobo App 中输入完成绑定
- **钱包发现**：自动检测本机已有的 CAW 钱包 Profile
- **Pact 授权**：创建支付预授权（单笔/日/月限额），手机审批后生效
- **多用户隔离**：每个应用用户独立 CAW HOME 目录，互不干扰

### 4. x402 支付集成

支持两个 x402 支付节点：

| 服务 | 网络 | 用途 |
|------|------|------|
| Venice AI | Base Mainnet | LLM 推理付费，按 token 计费 |
| BlockRun | Base Sepolia / Mainnet | x402 按次推理付费，~$0.001/次 |

x402 是 HTTP 原生支付协议：服务端返回 402 Payment Required，客户端用钱包签名支付 USDC，服务端验证后返回结果。

### 5. 积分账户系统

- 站内积分余额管理（1 USDC = 1000 积分）
- 自动充值阈值配置
- 积分账本（充值/消费/赠送记录）
- 链上 Topup Order 生命周期管理

### 6. Guardrails 限额策略

- 默认限额：单笔 1 USDC / 日 5 USDC / 月 20 USDC
- 白名单地址 / 链限制
- AI 推荐策略生成（可选，需要 OpenAI API Key）

---

## 技术架构

```
┌─────────────────────────────────────────────────────┐
│                    前端 (Next.js)                     │
│  Dashboard │ Wallet │ Venice │ BlockRun │ Settings    │
└──────────────────────┬──────────────────────────────┘
                       │ REST API
┌──────────────────────┴──────────────────────────────┐
│                 API Routes (Next.js)                  │
│  auth │ wallet/caw │ venice │ blockrun │ credits      │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────┴──────────────────────────────┐
│                   业务逻辑层 (lib/)                    │
│  caw/cli.ts │ venice/topup.ts │ secrets/store.ts      │
│  r34-sweep-heartbeat.ts (心跳轮询)                    │
└──────┬──────────────┬──────────────┬────────────────┘
       │              │              │
┌──────┴──────┐ ┌─────┴─────┐ ┌─────┴──────┐
│  Prisma/    │ │  CAW CLI  │ │ Venice AI  │
│  SQLite     │ │  (caw)    │ │ BlockRun   │
│  (本地DB)   │ │  (钱包)   │ │ (x402 API) │
└─────────────┘ └─────┬─────┘ └────────────┘
                      │
              ┌───────┴───────┐
              │  Base Mainnet │
              │  (USDC 链上)  │
              └───────────────┘
```

### 数据模型（Prisma + SQLite）

| 模型 | 说明 |
|------|------|
| `User` | 用户账户（邮箱、CAW 钱包绑定） |
| `CreditAccount` | 积分账户（余额、阈值） |
| `LedgerEntry` | 积分账本（充值/消费记录） |
| `TopupOrder` | 链上充值订单（状态机管理） |
| `CawAuthorization` | Pact 授权记录（限额、状态） |
| `CawPairingSession` | 配对码会话 |
| `CawOnboardingSession` | 钱包 Onboarding 状态 |
| `CawRuntimeCredential` | CAW 运行时凭据（加密） |
| `UserSecret` | 用户级加密配置（Treasury 等） |
| `Agent` / `AgentRun` | Agent 任务管理 |
| `VeniceTopupOrder` | Venice x402 充值订单 |
| `Guardrails` | 限额策略 |

---

## 使用的 API / SDK / AI 工具

### Cobo Agentic Wallet（CAW）

| 组件 | 用途 |
|------|------|
| `@cobo/agentic-wallet` SDK | Node.js SDK，钱包状态查询、Pact 管理 |
| `caw` CLI (v0.2.86+) | 命令行工具，钱包配对、Pact 创建、链上转账 |
| CAW HTTP API | `https://api.agenticwallet.cobo.com`，配对码/Pact/签名/转账 |

核心 API 端点：
- `POST /v1/pairing-codes` — 生成配对码
- `POST /v1/pacts` — 创建 Pact 授权
- `POST /v1/wallets/{id}/message-sign` — 消息签名（SIWE）
- `POST /v1/wallets/{id}/transactions` — 链上转账

### Venice AI

| API | 用途 |
|------|------|
| `POST /api/v1/chat/completions` | LLM 推理（Bearer / SIWE 认证） |
| `POST /api/v1/x402/top-up` | x402 USDC 充值（402 挑战 → 钱包支付） |
| `GET /api/v1/x402/balance/{address}` | SIWE 签名查询余额 |

### BlockRun

| API | 用途 |
|------|------|
| `POST /v1/chat/completions` | x402 按次推理（~$0.001/次） |
| 余额查询 | 通过 viem 读取链上 USDC 余额 |

### x402 协议

HTTP 原生支付协议（类似 HTTP 402 Payment Required）：
1. 客户端请求付费资源
2. 服务端返回 402 + `accepts[]`（支持的支付方式）
3. 客户端用钱包签名 USDC 支付
4. 服务端验证支付后返回资源

### AI 工具（可选）

| 工具 | 用途 |
|------|------|
| OpenAI GPT-4.1-mini | Pact 草稿 AI 生成（自然语言 → PactSpec） |
| Venice AI Llama-3.3-70b | Agent 推理任务执行 |

### 链上组件

| 组件 | 地址 |
|------|------|
| USDC 合约 (Base Mainnet) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| CreditsPayment 合约 | 项目自部署，监听链上购买事件 |
| Base RPC | `https://mainnet.base.org` |

---

## 快速开始

### 前置条件

- Node.js 18+
- [Cobo Agentic Wallet CLI](https://github.com/nicepkg/caw) v0.2.86+
- Base Mainnet 上有 USDC 的 CAW 钱包

### 安装

```bash
git clone https://github.com/0xpadawans/cobo-agent-autopay.git
cd cobo-agent-autopay
npm install
```

### 配置

```bash
cp .env.example .env.local
```

编辑 `.env.local`：

```bash
# CAW 钱包
AGENT_WALLET_API_URL=https://api.agenticwallet.cobo.com
AGENT_WALLET_API_KEY=caw_你的...
CAW_WALLET_ID=d776846c-...
CAW_WALLET_ADDRESS=0xaa56...

# 安全
NEXTAUTH_SECRET=你的随机密钥

# CAW CLI（必须用绝对路径）
CAW_CLI_HOME_ROOT=/absolute/path/to/.caw-cli-homes

# 链
CHAIN_ENV=base-mainnet
CAW_CHAIN_ID=BASE_ETH
USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
```

### 初始化数据库

```bash
npx prisma generate
npx prisma db push
```

### 启动

```bash
npm run dev
```

访问 http://localhost:3000，注册/登录后进入 Dashboard。

### 首次使用

1. **钱包** → 检测本机钱包 → 绑定 → 生成配对码 → Cobo App 输入配对码
2. **Venice** → 创建 Pact → Cobo App 审批 → 签名查询余额
3. **设置** → 配置自动充值阈值 / Treasury 钱包（可选）
4. **工作台** → 运行 Agent 任务，观察自动充值

---

## 部署

### Vercel

```bash
npm run build
# 在 Vercel Dashboard 配置环境变量后部署
```

### Docker

```bash
docker build -t cobo-agent-autopay .
docker run -p 3000:3000 --env-file .env.local cobo-agent-autopay
```

### 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `AGENT_WALLET_API_URL` | ✅ | CAW API 地址 |
| `AGENT_WALLET_API_KEY` | ✅ | CAW API 密钥 |
| `CAW_WALLET_ID` | ✅ | CAW 钱包 UUID |
| `CAW_WALLET_ADDRESS` | ✅ | 钱包链上地址 |
| `NEXTAUTH_SECRET` | ✅ | Session + 加密密钥 |
| `CHAIN_ENV` | ✅ | `base-mainnet` 或 `base-sepolia` |
| `CAW_CLI_HOME_ROOT` | ✅ | CAW CLI HOME 根目录（绝对路径） |
| `VENICE_API_KEY` | 可选 | Venice AI API Key |
| `OPENAI_API_KEY` | 可选 | Pact 草稿 AI 生成 |
| `TREASURY_ADDRESS` | 可选 | Treasury 钱包地址 |
| `SPENDING_WALLET_ADDRESS` | 可选 | Spending 钱包地址 |

---

## 开发

```bash
npm run dev          # 开发服务器
npm run build        # 生产构建
npm run typecheck    # TypeScript 检查
npm run lint         # ESLint
npm run db:studio    # Prisma Studio（数据库可视化）
```

---

## License

Private — 仅限内部使用
