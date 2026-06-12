// Venice x402 top-up via caw fetch.
// 1. Discover payment requirements: POST /x402/top-up without X-402-Payment header
//    -> returns 402 with accepts[] (Base/Solana USDC options)
// 2. Pay via caw fetch (which handles the x402 challenge automatically using the
//    wallet bound to the active pact).
//
// This is the x402 native path: agent pays USDC from the CAW wallet, Venice
// credits the corresponding balance. No Venice API key required for the credit
// balance side; SIWE auth is bypassed because payment itself proves identity.

import { spawn } from "node:child_process";
import { getCawRuntimeStatus } from "@/lib/caw/gateway";
import { getCreditRepository } from "@/lib/store";
import { createInferenceLog } from "@/lib/store/venice";
import { nowIso } from "@/lib/store/memory";

// ── Payment lock ──────────────────────────────────────────────────────────
export type PaymentLockState = 'idle' | 'processing' | 'cooldown';

let paymentLock: PaymentLockState = 'idle';
let lockTimer: NodeJS.Timeout | null = null;
const LOCK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes hard unlock
const COOLDOWN_MS = 30_000;            // 30 seconds cool-down after success

export function getPaymentLockState(): PaymentLockState {
  return paymentLock;
}

function setLock(state: PaymentLockState, timeoutMs?: number): void {
  paymentLock = state;
  if (lockTimer) {
    clearTimeout(lockTimer);
    lockTimer = null;
  }
  if (timeoutMs !== undefined) {
    lockTimer = setTimeout(() => {
      console.warn(`[payment-lock] Timer expired after ${timeoutMs}ms, forcing idle`);
      paymentLock = 'idle';
      lockTimer = null;
    }, timeoutMs);
  }
}

// 钱包互充：Spending 钱包 USDC 不足时 Treasury 自动补充
export async function onInsufficientWalletBalance(userId: string): Promise<void> {
  // 从数据库读取 Treasury 配置
  const { getUserSecrets } = await import("@/lib/secrets/store");
  const secrets = await getUserSecrets(userId, [
    "TREASURY_API_KEY",
    "TREASURY_API_URL",
    "TREASURY_PACT_ID",
    "TREASURY_TOPUP_AMOUNT",
  ]);

  const apiKey = secrets["TREASURY_API_KEY"];
  const apiUrl = secrets["TREASURY_API_URL"] || process.env.CAW_API_URL;
  const pactId = secrets["TREASURY_PACT_ID"];
  const amount = Number(secrets["TREASURY_TOPUP_AMOUNT"]) || 20;
  const dstAddress = process.env.SPENDING_WALLET_ADDRESS;

  if (!apiKey || !pactId || !dstAddress) {
    console.log("[treasury] 互充未配置，跳过（缺少 TREASURY_API_KEY 或 TREASURY_PACT_ID 或 SPENDING_WALLET_ADDRESS）");
    return;
  }

  // USDC minor units (6 decimals)
  const amountMinor = Math.round(amount * 1_000_000);

  console.log(`[treasury] 触发互充 → 转账 ${amount} USDC → ${dstAddress.slice(0, 6)}...${dstAddress.slice(-4)}`);

  // Fire-and-forget：不等待结果，不抛异常
  const { runTreasuryTransfer } = await import("@/lib/caw/transfer");
  runTreasuryTransfer({
    pactId,
    dstAddress,
    tokenId: "BASE_USDC",
    amount: amountMinor,
    chainId: "BASE",
    apiKey,
    apiUrl: apiUrl!,
  })
    .then((result) => {
      if (result.success) {
        console.log(`[treasury] ✅ 互充完成，txHash: ${result.txHash}`);
      } else if (result.error === "TRANSFER_COOLDOWN") {
        console.log("[treasury] ⏳ 互充冷却中，跳过");
      } else {
        console.log(`[treasury] ❌ 互充失败：${result.error}`);
      }
    })
    .catch((err: Error) =>
      console.log(`[treasury] ❌ 互充异常：${err.message}`)
    );
}

// ── Existing imports below ────────────────────────────────────────────────
import type { VeniceX402TopupRequest, VeniceX402TopupResult } from "@/lib/venice/types";
import { getVeniceBaseUrl } from "@/lib/config/store";

const VENICE_X402_TOPUP_PATH = "/api/v1/x402/top-up";

export type VeniceX402Accept = {
  protocol: "x402";
  version: 2;
  network: "BASE_ETH" | "solana" | string;
  asset: string;
  amount: string;
  maxAmountRequired?: string;
  payTo: string;
  extra?: {
    name?: string;
    version?: string;
    feePayer?: string;
  };
};

type X402PaymentRequirementV2 = {
  x402Version: 2;
  accepts: VeniceX402Accept[];
  error?: string;
  resource?: { url?: string; description?: string; mimeType?: string };
  authOptions?: { apiKey?: { header?: string; docs?: string } };
};

export async function discoverVeniceX402Requirements(): Promise<X402PaymentRequirementV2> {
  const url = `${getVeniceBaseUrl()}${VENICE_X402_TOPUP_PATH}`;
  const res = await fetch(url, { method: "POST", cache: "no-store" });
  if (res.status !== 402) {
    throw new Error(`Expected 402 from Venice ${VENICE_X402_TOPUP_PATH}, got ${res.status}`);
  }
  const body = (await res.json()) as X402PaymentRequirementV2;
  if (!body.accepts || body.accepts.length === 0) {
    throw new Error("Venice /api/v1/x402/top-up returned 402 with no accepts[] options");
  }
  return body;
}

export function pickBaseUsdcAccept(reqs: X402PaymentRequirementV2) {
  const base = reqs.accepts.find((a) => a.network === "BASE_ETH" || a.network === "base");
  if (base) return base;
  // Fallback: any USDC option
  const usdc = reqs.accepts.find((a) => a.asset?.toUpperCase().includes("USDC"));
  return usdc ?? reqs.accepts[0];
}
// Alias for remote wiki branch import
export const pickVeniceBaseUsdcAccept = pickBaseUsdcAccept;

// ── runCawFetch (本地副本，复用逻辑) ──────────────────────────────────────
function runCawFetch(
  pactId: string,
  url: string,
  body: object,
  network?: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const args = [
      "fetch",
      pactId,
      url,
      "--method", "POST",
      "--json", JSON.stringify(body),
      "--protocol", "x402",
      "--max-amount", "1000000000", // 1000 USDC cap
      "--network", network ?? "eip155:84532",
      "--output", "full",
      "--timeout", "60",
    ];
    const child = spawn("caw", args, {
      env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
  });
}

// ── BlockRun x402 推理执行 ────────────────────────────────────────────────
export async function runVeniceX402Topup(input: {
  userId: string;
  agentId?: string;
  agentRunId?: string;
  walletAddress: string;
  pactId: string;
  usdAmount: number;
}): Promise<VeniceX402TopupResult> {
  // ── Payment lock check ────────────────────────────────────────────────
  const lockState = getPaymentLockState();
  if (lockState !== 'idle') {
    console.warn(`[payment-lock] runVeniceX402Topup blocked by state=${lockState}`);
    return {
      status: "failed",
      paymentPayload: "",
      responseStatus: 0,
      responseBody: "",
      durationMs: 0,
    } as VeniceX402TopupResult & { error: string };
  }
  setLock('processing', LOCK_TIMEOUT_MS);

  const start = Date.now();
  // Sanity checks
  const runtime = await getCawRuntimeStatus();
  if (runtime.mode === "mock") {
    // Mock 模式：模拟 CAW 钱包 USDC 不足，触发 Treasury 互充
    console.log(`[mock] 模拟 CAW 钱包 USDC 不足，触发 Treasury 互充 (userId=${input.userId})`);
    setLock('idle');
    void onInsufficientWalletBalance(input.userId);
    return {
      status: "failed",
      paymentPayload: "",
      responseStatus: 402,
      responseBody: "MOCK_INSUFFICIENT_FUNDS",
      durationMs: 0,
    } as VeniceX402TopupResult;
  }
  if (runtime.mode !== "http") {
    setLock('idle');
    throw new Error("Venice x402 top-up requires real CAW mode (CAW_MODE=http).");
  }
  if (!input.pactId) {
    setLock('idle');
    throw new Error("An active Pact is required. Create one from the dashboard first.");
  }

  // Convert USD to USDC minor units (USDC has 6 decimals)
  const usdcMinor = Math.max(1000, Math.round(input.usdAmount * 1_000_000));

  const url = `${getVeniceBaseUrl()}${VENICE_X402_TOPUP_PATH}`;
  const body = { usdAmount: input.usdAmount, minorUnits: usdcMinor };

  let result: Awaited<ReturnType<typeof runCawFetch>>;
  try {
    result = await runCawFetch(input.pactId, url, body);
  } catch (error) {
    setLock('idle');
    throw error;
  }
  const durationMs = Date.now() - start;

  // caw fetch --output=full prints HTTP status line + headers + body
  // Try to parse out the status code from the first line
  const statusLine = result.stdout.split("\n")[0]?.trim() ?? "";
  const statusMatch = statusLine.match(/\b(\d{3})\b/);
  const responseStatus = statusMatch ? Number(statusMatch[1]) : 0;
  const success = responseStatus >= 200 && responseStatus < 300;

  // Log a ledger-style entry (we use inference log table for top-ups too, prefix model)
  createInferenceLog({
    userId: input.userId,
    prompt: `x402 top-up: $${input.usdAmount} USDC → Venice credit balance`,
    model: "venice-x402-topup",
    response: result.stdout.slice(0, 2000),
    inputTokens: null,
    outputTokens: null,
    status: success ? "completed" : "failed",
    errorMessage: success ? undefined : (result.stderr || result.stdout).slice(0, 1000),
    durationMs
  });

  // Only refresh balance on success
  let balance: Awaited<ReturnType<typeof refreshVeniceBalance>> | undefined;
  if (success) {
    try {
      const { refreshVeniceBalance } = await import("@/lib/venice/balance");
      balance = await refreshVeniceBalance({ walletAddress: input.walletAddress });
    } catch {
      // Non-fatal: best-effort balance refresh
    }
  }

  if (success) {
    setLock('cooldown');
    setTimeout(() => setLock('idle'), COOLDOWN_MS);
  } else {
    setLock('idle');
    // Check for insufficient funds → fire hook
    if (/insufficient.*fund|INSUFFICIENT_FUNDS/i.test(result.stderr + result.stdout)) {
      void onInsufficientWalletBalance(input.userId);
    }
  }

  return {
    status: success ? "submitted" : "failed",
    balance,
    paymentPayload: "",
    responseStatus,
    responseBody: result.stdout,
    durationMs
  };
}

async function refreshVeniceBalance(input: {
  walletAddress?: string;
}): Promise<{ usdBalance: number; canConsume: boolean }> {
  try {
    const { veniceRequest } = await import("@/lib/venice/client");
    const res = await veniceRequest({
      path: `/api/v1/billing/balance`,
      passthrough: true,
    });
    return {
      usdBalance: Number((res.body as Record<string, unknown>)?.usdBalance ?? 0),
      canConsume: Boolean((res.body as Record<string, unknown>)?.canConsume),
    };
  } catch {
    return { usdBalance: 0, canConsume: false };
  }
}

export async function getOrCreateVeniceX402TopupRequest(args: {
  userId: string;
  usdAmount: number;
}): Promise<VeniceX402TopupRequest> {
  const repo = getCreditRepository();
  const user = await repo.requireUser(args.userId);
  if (!user.cawWalletAddress) {
    throw new Error("Connect a CAW wallet first.");
  }
  const auth = await repo.getActiveAuthorization(args.userId, "venice_x402");
  if (!auth || auth.status !== "active") {
    throw new Error("An active Pact is required. Create one from the dashboard first.");
  }
  return {
    walletAddress: user.cawWalletAddress,
    pactId: auth.pactId,
    usdAmount: args.usdAmount
  };
}
