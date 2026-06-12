// lib/r34-sweep-heartbeat.ts
// R4.0 — heartbeat that drives R3.4 expireStaleTopupOrders() sweep
// on a fixed interval. The sweep transitions caw_submitted / chain_pending /
// pending_approval / pending_policy topup_orders older than 30 minutes
// to status="approval_expired".
//
// ⚠️ v1.20 修法 (cobo-agent-autopay 2026-06-07 cron R4.0 实现):
//   - 文件顶层 **不** 静态 import `@/lib/domain/services` 或 `@/lib/store`.
//     services → store → memory-repo → node:crypto 静态链会触发 webpack
//     UnhandledSchemeError (v1.16 trap).
//   - tick 内部用 `await import("@/lib/domain/services")` 动态加载
//     expireStaleTopupOrders. webpack 把 dynamic import 切成独立 async chunk,
//     不在静态 module graph 里.
//   - `import "server-only"` 防客户端误 import.
//   - globalThis 守卫防 HMR 重复启动.
//   - 所有错误 swallow —— heartbeat 启动失败不能让 dev server 挂.
//   - 默认 5 分钟 (300000ms) 一轮, env `R34_SWEEP_INTERVAL_MS` 覆盖.
//   - instrumentation.ts 启动 register() (Next.js 15 stable hook).
//   - 此外: 第一次 GET /api/credits/topup/sweep-status 调
//     ensureR34SweepHeartbeatRunning() 懒启动, 适配 cron tick
//     单次实现 (避免 dev server 重启).
//
// ⚠️ v1.20 已知限制:
//   - tick 改 `lib/domain/services.ts` (例如改 STALE_TOPUP_TIMEOUT_MS) 不会
//     生效: dynamic import 缓存的 chunk 仍跑老代码. 必须 dev server 重启
//     或调 stopR34SweepHeartbeat + startR34SweepHeartbeat 拿新 chunk.
//   - 改 `lib/r34-sweep-heartbeat.ts` 本身 HMR 不会重跑 setInterval, 旧
//     handle 继续用旧文件. 同上, 重启或 stop+start 解决.

import "server-only";

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 min
const MIN_INTERVAL_MS = 30 * 1000; // 30s sanity floor
const FIRST_TICK_DELAY_MS = 5_000;
const BALANCE_CHECK_INTERVAL_MS = 60_000; // 60s

// ── Venice balance ────────────────────────────────────────────────────────
const VENICE_X402_WALLET = process.env.VENICE_X402_WALLET || "";

function resolveVeniceBalanceThreshold(): number {
  return Number(
    process.env.VENICE_BALANCE_THRESHOLD ?? 5
  );
}

function isVeniceAutoTopupEnabled(): boolean {
  return process.env.VENICE_AUTO_X402_TOPUP_ENABLED === "1";
}

type R34SweepHeartbeatState = {
  intervalHandle: ReturnType<typeof setInterval> | undefined;
  balanceHandle: ReturnType<typeof setInterval> | undefined;
  firstTickTimer: ReturnType<typeof setTimeout> | undefined;
  lastRunAt: string | undefined;
  lastError: string | undefined;
  lastExpiredCount: number | undefined;
  lastFailedCount: number | undefined;
  lastCutoffIso: string | undefined;
  consecutiveFailures: number;
  startedAt: string | undefined;
  // Venice balance polling
  veniceBalanceUsd: number;
  veniceBalanceThreshold: number;
  lastBalanceCheckAt: string | undefined;
};

declare global {
  // eslint-disable-next-line no-var
  var __R34_SWEEP_HEARTBEAT_STATE__: R34SweepHeartbeatState | undefined;
}

function getState(): R34SweepHeartbeatState {
  if (!globalThis.__R34_SWEEP_HEARTBEAT_STATE__) {
    globalThis.__R34_SWEEP_HEARTBEAT_STATE__ = {
      intervalHandle: undefined,
      balanceHandle: undefined,
      firstTickTimer: undefined,
      lastRunAt: undefined,
      lastError: undefined,
      lastExpiredCount: undefined,
      lastFailedCount: undefined,
      lastCutoffIso: undefined,
      consecutiveFailures: 0,
      startedAt: undefined,
      veniceBalanceUsd: 0,
      veniceBalanceThreshold: resolveVeniceBalanceThreshold(),
      lastBalanceCheckAt: undefined
    };
  }
  return globalThis.__R34_SWEEP_HEARTBEAT_STATE__;
}

// ── BlockRun balance monitoring ──────────────────────────────────────────
// BlockRun 和 Venice 不同：BlockRun 是实时扣款，每次推理直接从 CAW 钱包扣 USDC。
// 这里监控 CAW 钱包 USDC 余额，低于阈值时仅告警（不自动充值）。
//
// 后台任务没有登录用户上下文，只读取显式配置的钱包地址。

import { createPublicClient, http as viemHttp, formatUnits } from "viem";
import { base, baseSepolia } from "viem/chains";

type BlockRunBalanceState = {
  usdBalance: number;
  minBalance: number;
  lastCheckAt: string | undefined;
  lastError: string | undefined;
  lastAutoTopupAt: string | undefined;
  lastAutoTopupResult: string | undefined;
  autoTopupEnabled: boolean;
};

const DEFAULT_BLOCKRUN_MIN_BALANCE = 5;

function getBlockRunBalanceState(): BlockRunBalanceState {
  // Attached to the heartbeat global — no separate global needed
  const g = globalThis as typeof globalThis & { __BLOCKRUN_BALANCE_STATE__?: BlockRunBalanceState };
  if (!g.__BLOCKRUN_BALANCE_STATE__) {
    g.__BLOCKRUN_BALANCE_STATE__ = {
      usdBalance: 0,
      minBalance: Number(process.env.BLOCKRUN_MIN_BALANCE ?? DEFAULT_BLOCKRUN_MIN_BALANCE),
      lastCheckAt: undefined,
      lastError: undefined,
      lastAutoTopupAt: undefined,
      lastAutoTopupResult: undefined,
      autoTopupEnabled: process.env.BLOCKRUN_AUTO_TOPUP_ENABLED === "1",
    };
  }
  return g.__BLOCKRUN_BALANCE_STATE__!;
}

async function readCawWalletUsdcBalance(): Promise<number | null> {
  // 用 viem 直接读显式配置钱包的链上 USDC 余额，避免使用默认 CAW profile。
  try {
    const isTestnet = process.env.BLOCKRUN_USE_TESTNET !== "false";
    const chain = isTestnet ? baseSepolia : base;
    const client = createPublicClient({ chain, transport: viemHttp() });
    const usdcAddress = isTestnet
      ? "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
      : "0x833589fCD6eDb6E08f4c7c32D4f71b54bDA02913";
    const abi = [{ constant: true, inputs: [{ name: "_owner", type: "address" }], name: "balanceOf", outputs: [{ name: "balance", type: "uint256" }], type: "function" }] as const;
    const walletAddress = process.env.BLOCKRUN_WALLET_ADDRESS || process.env.BASE_WALLET_ADDRESS;
    if (!walletAddress) {
      console.warn("[blockrun-balance] BLOCKRUN_WALLET_ADDRESS not set, skipping viem balance check");
      return null;
    }
    const balance = await client.readContract({ address: usdcAddress as `0x${string}`, abi, functionName: "balanceOf", args: [walletAddress as `0x${string}`] });
    return Number(formatUnits(balance as bigint, 6));
  } catch (err) {
    console.warn("[blockrun-balance] balance check failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

async function checkBlockRunBalance(): Promise<void> {
  const state = getBlockRunBalanceState();
  state.minBalance = Number(process.env.BLOCKRUN_MIN_BALANCE ?? DEFAULT_BLOCKRUN_MIN_BALANCE);
  state.autoTopupEnabled = process.env.BLOCKRUN_AUTO_TOPUP_ENABLED === "1";

  try {
    const balance = await readCawWalletUsdcBalance();
    if (balance === null) {
      state.lastError = "Failed to read USDC balance";
      return;
    }
    state.usdBalance = balance;
    state.lastCheckAt = new Date().toISOString();
    state.lastError = undefined;

    if (balance < state.minBalance) {
      console.log(
        `[blockrun] CAW USDC 余额不足（当前：$${balance.toFixed(2)}，阈值：$${state.minBalance.toFixed(2)}）`
      );

      // 自动充值
      if (state.autoTopupEnabled) {
        if (process.env.BLOCKRUN_ALLOW_GLOBAL_AUTOTOPUP !== "1") {
          state.lastAutoTopupResult = "skipped_global_autotopup_disabled_for_multi_user";
          console.log("[blockrun] 全局钱包自动充值已默认禁用；如需旧 demo 行为，设置 BLOCKRUN_ALLOW_GLOBAL_AUTOTOPUP=1");
          return;
        }
        console.log("[blockrun] 触发自动充值...");
        try {
          const blockrun = await import("@/lib/blockrun/topup");
          const repo = await import("@/lib/store").then(m => m.getCreditRepository());
          // 用实际 CAW 钱包地址反查真实用户，不再依赖 DEMO_USER_ID
          const cawWallet = process.env.CAW_WALLET_ADDRESS || process.env.BLOCKRUN_WALLET_ADDRESS;
          if (!cawWallet) {
            state.lastAutoTopupResult = "no_caw_wallet_env";
            console.log("[blockrun] CAW_WALLET_ADDRESS 未设置，跳过自动充值");
            return;
          }
          const user = await repo.findUserByCawWalletAddress(cawWallet);
          if (!user) {
            state.lastAutoTopupResult = "no_user_with_caw_wallet";
            console.log("[blockrun] 找不到绑定该 CAW 钱包的用户，跳过自动充值");
            return;
          }

          if (user.cawWalletAddress) {
            // 先从数据库找 pact
            let pactId: string | undefined;
            const auth = await repo.getActiveAuthorization(user.id, "blockrun_x402");
            if (auth?.status === "active") {
              pactId = auth.pactId;
            }

            // 数据库没有，从 CAW 直接找
            if (!pactId) {
              const { spawn } = await import("node:child_process");
              pactId = await new Promise<string | undefined>((resolve) => {
                const child = spawn("caw", ["pact", "list"], {
                  env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: "0" },
                  stdio: ["ignore", "pipe", "pipe"],
                });
                let stdout = "";
                child.stdout.on("data", (b: Buffer) => (stdout += b.toString()));
                child.on("close", () => {
                  try {
                    const result = JSON.parse(stdout);
                    for (const p of result.result?.pacts || []) {
                      if (p.status === "active" && (p.name || "").toLowerCase().includes("blockrun")) {
                        resolve(p.id);
                        return;
                      }
                    }
                    resolve(undefined);
                  } catch { resolve(undefined); }
                });
                child.on("error", () => resolve(undefined));
              });
            }

            if (pactId) {
              const result = await blockrun.runBlockRunX402Inference({
                userId: user.id,
                walletAddress: user.cawWalletAddress,
                pactId,
                messages: [{ role: "user", content: "auto top-up ping" }],
                usdAmount: 0.01,
              });
              state.lastAutoTopupAt = new Date().toISOString();
              state.lastAutoTopupResult = result.status === "completed" ? "success" : `failed: ${result.error || "unknown"}`;
              console.log(`[blockrun] 自动充值结果: ${state.lastAutoTopupResult}`);
            } else {
              state.lastAutoTopupResult = "no_active_pact";
              console.log("[blockrun] 无 active BlockRun Pact，跳过自动充值");
            }
          }
        } catch (e) {
          state.lastAutoTopupAt = new Date().toISOString();
          state.lastAutoTopupResult = `error: ${e instanceof Error ? e.message : "unknown"}`;
          console.warn("[blockrun] 自动充值失败:", state.lastAutoTopupResult);
        }
      } else {
        console.log("[blockrun] 自动充值未启用（BLOCKRUN_AUTO_TOPUP_ENABLED=1 开启）");
      }
    } else {
      console.log(
        `[blockrun] CAW USDC 余额充足（当前：$${balance.toFixed(2)}，阈值：$${state.minBalance.toFixed(2)}）`
      );
    }
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : "unknown error";
    console.warn("[blockrun-balance] check failed:", state.lastError);
  }
}

function resolveIntervalMs(): number {
  const raw = Number.parseInt(process.env.R34_SWEEP_INTERVAL_MS ?? "", 10);
  if (Number.isFinite(raw) && raw >= MIN_INTERVAL_MS) return raw;
  return DEFAULT_INTERVAL_MS;
}

type R34SweepTickResult = {
  ok: boolean;
  expiredCount?: number;
  failedCount?: number;
  cutoffIso?: string;
  error?: string;
};

async function runR34SweepTick(): Promise<R34SweepTickResult> {
  // ⚠️ Dynamic import — 切 chunk, 避开静态 module graph.
  const services = await import("@/lib/domain/services");
  try {
    const result = await services.expireStaleTopupOrders({});

    return {
      ok: true,
      expiredCount: result.expiredCount,
      failedCount: result.failedCount,
      cutoffIso: result.cutoffIso
    };
  } catch (caught) {
    return {
      ok: false,
      error: caught instanceof Error ? caught.message : "unknown_error"
    };
  }
}

// ── Venice balance polling (60s independent timer) ─────────────────────
async function checkVeniceBalance(): Promise<void> {
  const state = getState();
  state.veniceBalanceThreshold = resolveVeniceBalanceThreshold();
  try {
    // Mock mode: VENICE_MOCK_BALANCE overrides real balance check
    const mockBalanceStr = process.env.VENICE_MOCK_BALANCE;
    let usdBalance: number;
    if (mockBalanceStr !== undefined) {
      usdBalance = Number(mockBalanceStr);
      console.log(`[venice-balance] MOCK balance=${usdBalance}, threshold=${state.veniceBalanceThreshold}`);
    } else {
      const { refreshVeniceBalance } = await import("@/lib/venice/balance");
      const balance = await refreshVeniceBalance({ walletAddress: VENICE_X402_WALLET });
      usdBalance = balance.usdBalance;
    }
    state.veniceBalanceUsd = usdBalance;
    state.lastBalanceCheckAt = new Date().toISOString();

    // Below threshold → auto top-up if lock is idle
    if (usdBalance < state.veniceBalanceThreshold && isVeniceAutoTopupEnabled()) {
      if (process.env.VENICE_ALLOW_DEMO_AUTOTOPUP !== "1") {
        console.log("[venice-balance] 全局 demo 自动充值已默认禁用；用户级自动支付由 Agent/user 流程触发");
        return;
      }
      const topup = await import("@/lib/venice/topup");
      const lockState = topup.getPaymentLockState();
      if (lockState === "idle") {
        const repo = await import("@/lib/store").then(m => m.getCreditRepository());
        const { DEMO_USER_ID } = await import("@/lib/domain/constants");
        const user = await repo.requireUser(DEMO_USER_ID);
        if (user.cawWalletAddress) {
          try {
            const auth = await repo.getActiveAuthorization(user.id, "venice_x402");
            if (auth?.status === "active") {
              await topup.runVeniceX402Topup({
                userId: user.id,
                walletAddress: user.cawWalletAddress,
                pactId: auth.pactId,
                usdAmount: state.veniceBalanceThreshold
              });
            }
          } catch (e) {
            console.warn("[venice-balance] Auto top-up failed for user:", user.id, e);
          }
        }
      } else {
        console.log(`[venice-balance] Balance below threshold but lock busy (${lockState}), skipping auto top-up`);
      }
    } else if (usdBalance < state.veniceBalanceThreshold) {
      console.log("[venice-balance] Balance below threshold; auto top-up disabled");
    }
  } catch (balanceErr) {
    console.warn("[venice-balance] balance check failed:", balanceErr);
  }
}

function tickWithState(): Promise<void> {
  return runR34SweepTick()
    .then((result) => {
      const state = getState();
      state.lastRunAt = new Date().toISOString();
      if (result.ok) {
        state.lastError = undefined;
        state.lastExpiredCount = result.expiredCount;
        state.lastFailedCount = result.failedCount;
        state.lastCutoffIso = result.cutoffIso;
        state.consecutiveFailures = 0;
      } else {
        state.lastError = result.error ?? "unknown_error";
        state.consecutiveFailures += 1;
      }
    })
    .catch((caught: unknown) => {
      const state = getState();
      state.lastRunAt = new Date().toISOString();
      state.lastError = caught instanceof Error ? caught.message : "unknown_error";
      state.consecutiveFailures += 1;
    });
}

export function startR34SweepHeartbeat(): void {
  const state = getState();
  if (state.intervalHandle) return; // already running
  const intervalMs = resolveIntervalMs();
  state.startedAt = new Date().toISOString();
  // 5s 后跑首轮, 让 dev server 启动期别太挤
  state.firstTickTimer = setTimeout(() => {
    void tickWithState();
  }, FIRST_TICK_DELAY_MS);
  state.intervalHandle = setInterval(() => {
    void tickWithState();
  }, intervalMs);
  // eslint-disable-next-line no-console
  console.log(
    `[r34-sweep-heartbeat] started, interval=${intervalMs}ms, first-tick-in=${FIRST_TICK_DELAY_MS}ms`
  );
  // Start independent balance checker (60s)
  if (!state.balanceHandle) {
    void Promise.allSettled([
      checkVeniceBalance(),
      checkBlockRunBalance(),
    ]);
    state.balanceHandle = setInterval(() => {
      void Promise.allSettled([
        checkVeniceBalance(),
        checkBlockRunBalance(),
      ]);
    }, BALANCE_CHECK_INTERVAL_MS);
  }
}

export function stopR34SweepHeartbeat(): void {
  const state = getState();
  if (state.firstTickTimer) {
    clearTimeout(state.firstTickTimer);
    state.firstTickTimer = undefined;
  }
  if (state.intervalHandle) {
    clearInterval(state.intervalHandle);
    state.intervalHandle = undefined;
    // eslint-disable-next-line no-console
    console.log("[r34-sweep-heartbeat] stopped");
  }
  if (state.balanceHandle) {
    clearInterval(state.balanceHandle);
    state.balanceHandle = undefined;
  }
}

export function ensureR34SweepHeartbeatRunning(): void {
  const state = getState();
  if (!state.intervalHandle) {
    startR34SweepHeartbeat();
  }
}

export type R34SweepHeartbeatStatus = {
  running: boolean;
  startedAt: string | undefined;
  lastRunAt: string | undefined;
  lastError: string | undefined;
  lastExpiredCount: number | undefined;
  lastFailedCount: number | undefined;
  lastCutoffIso: string | undefined;
  consecutiveFailures: number;
  intervalMs: number;
  veniceBalanceUsd: number;
  veniceBalanceThreshold: number;
  lastBalanceCheckAt: string | undefined;
  blockrunBalanceUsd: number;
  blockrunMinBalance: number;
  blockrunAutoTopupEnabled: boolean;
  blockrunLastAutoTopupAt: string | undefined;
  blockrunLastAutoTopupResult: string | undefined;
};

export function getR34SweepHeartbeatStatus(): R34SweepHeartbeatStatus {
  const state = getState();
  const blockrunState = getBlockRunBalanceState();
  return {
    running: Boolean(state.intervalHandle),
    startedAt: state.startedAt,
    lastRunAt: state.lastRunAt,
    lastError: state.lastError,
    lastExpiredCount: state.lastExpiredCount,
    lastFailedCount: state.lastFailedCount,
    lastCutoffIso: state.lastCutoffIso,
    consecutiveFailures: state.consecutiveFailures,
    intervalMs: resolveIntervalMs(),
    veniceBalanceUsd: state.veniceBalanceUsd,
    veniceBalanceThreshold: state.veniceBalanceThreshold,
    lastBalanceCheckAt: state.lastBalanceCheckAt,
    blockrunBalanceUsd: blockrunState.usdBalance,
    blockrunMinBalance: blockrunState.minBalance,
    blockrunAutoTopupEnabled: blockrunState.autoTopupEnabled,
    blockrunLastAutoTopupAt: blockrunState.lastAutoTopupAt,
    blockrunLastAutoTopupResult: blockrunState.lastAutoTopupResult,
  };
}
