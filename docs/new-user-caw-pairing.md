# 多用户 CAW 钱包绑定和配对流程

本文档说明当前项目里“一个登录用户绑定一个 CAW 钱包”的实际使用方式，以及还没有完成的生产多租户限制。

## 当前支持状态

当前版本已经不是纯单钱包演示模式。用户用邮箱登录后，系统会按数据库 `userId` 保存：

- CAW Wallet UUID 和 EVM wallet address
- CAW onboarding session
- CAW runtime credential metadata
- Pact authorization
- top-up orders、Venice top-up orders、Agent runs

同一个 CAW Wallet UUID 或 wallet address 不能绑定给两个 app user。用户再次用同一个 email 登录时，会加载同一个数据库用户，因此页面会继续展示和操作之前绑定的钱包记录。

CLI-backed onboarding、配对状态、钱包发现、Pact 提交按 `userId` 使用隔离的 CAW CLI home。USDC approval、credits top-up execution、CAW transaction listing 等 CAW SDK gateway 路径也会从当前用户的 runtime credential/profile 初始化，不会在业务路径里静默回退到部署默认钱包。

当前仍保留一个生产加固点：`caw_runtime_credentials.apiKeyEncrypted` 现在保存的是 `caw-cli-profile:<walletId>` 标记，真实 API key 仍来自该用户隔离 CAW CLI home 里的 profile 文件。生产环境应把它升级为真正的加密 API key 存储和服务端解密。

## 新用户首次使用步骤

1. 管理员先准备基础环境：

```env
STORAGE_DRIVER=prisma
CAW_MODE=http
CAW_CHAIN_ID=TBASE_SETH
CHAIN_ENV=base-sepolia
AUTH_SESSION_SECRET=<random-secret>
PAYMENT_CONTRACT_ADDRESS=<deployed-credits-payment-contract>
TREASURY_ADDRESS=<treasury-address>
```

2. 初始化数据库：

```bash
npm run db:init
```

3. 用户打开 `/login`，输入自己的 email 登录。系统会创建或加载该 email 对应的数据库用户。
4. 为该用户准备一个独立 CAW Agent Wallet。不要把另一个用户已经绑定或配对过的钱包复用给新人。
5. 进入 `/dashboard/wallet`。
6. 如果服务器上已经有该用户对应的 CAW CLI profile，可以使用“检测本机钱包”或“自动绑定默认钱包”；也可以手动输入 Wallet UUID 绑定。
7. 绑定成功后，系统会把 Wallet UUID、wallet address、agent id、api url 等 metadata 写入数据库。
8. 点击“生成配对码”。
9. 用户打开手机 Cobo Agentic Wallet App，输入页面显示的配对码。
10. 配对完成后，点击“连接 CAW”。
11. 给该用户的钱包准备 Base Sepolia ETH gas 和 Base Sepolia USDC。
12. 创建 Pact，让用户在手机 App 里批准。
13. 给 `CreditsPayment` 合约授权 USDC allowance。
14. 再执行小额真实支付测试。

## 再次登录会发生什么

同一个 email 再次登录时，session 会指向同一个数据库 `userId`。页面和 API 会读取该用户自己的：

- `users.cawWalletId`
- `users.cawWalletAddress`
- `caw_wallet_onboarding_sessions`
- `caw_runtime_credentials`
- `caw_authorizations`
- 该用户的订单和 Agent run 记录

因此，钱包绑定和业务记录会保留，不需要每次登录都重新绑定。前提是部署必须使用 Prisma/database 存储；如果使用默认 memory store，服务重启后数据会丢失。

## 已配对钱包为什么不能再次输入验证码

CAW 配对码用于把一个 Agent Wallet 的所有权转移给手机 App 用户。

如果当前钱包已经配对完成，新用户再输入同一个钱包的验证码可能会看到“验证失败”。这通常表示这个钱包已经属于另一个用户或另一个手机 App 账号。

处理方式：

```text
新用户 = 新 CAW Agent Wallet + 新数据库绑定 + 新配对码
旧钱包换手机 = 走 CAW restore / re-pair 流程
```

## 不能提交到 git 的内容

以下内容只能放在本地或部署平台环境变量里：

```text
AGENT_WALLET_API_KEY
CAW_API_KEY
CAW_PACT_API_KEY
私钥
助记词
临时配对码
```

## 后续产品化方向

后端已经保存每个业务用户的 CAW wallet id、wallet address、pairing status、Pact id 和授权状态，并且主要 CAW SDK 执行路径会按当前用户读取 credential/profile。

推荐下一步：

1. 为每个用户创建独立 CAW Agent Wallet。
2. 对 `apiKeyEncrypted` 做真正的加密/解密，而不是只保存 `caw-cli-profile:<walletId>` 标记。
3. 给每个用户的 CAW profile/credential 增加轮换和失效检测。
4. 增加多用户真实支付的端到端回归测试。
