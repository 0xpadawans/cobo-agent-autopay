// lib/caw/transfer.ts
// Treasury Agent → Spending Wallet USDC 转账
// 通过 caw tx transfer CLI + --api-key/--api-url 切换身份
//
// 设计原则：
// - 防重复：Cooldown + transferInProgress 双重保护
// - Fire-and-forget：绝不阻塞调用方
// - 无 userId 依赖：Treasury 认证完全通过 CLI 参数，不走 CAW profile HOME 隔离
// - All errors swallowed（by design）：钩子调用处不 catch

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TRANSFER_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 1024 * 1024;

// ── 防重复状态 ──────────────────────────────────────────────────────────────
let transferInProgress = false;
let lastTransferAt = 0;
const TRANSFER_COOLDOWN_MS = 60 * 1000; // 1 分钟冷却

export type TreasuryStatus = "idle" | "transferring" | "completed" | "failed";

let treasuryStatus: TreasuryStatus = "idle";
let treasuryLastAmount: number | null = null;
let treasuryLastTransferAt: string | null = null;

export function getTreasuryStatus() {
  return { treasuryStatus, treasuryLastAmount, treasuryLastTransferAt };
}

// ── 主函数 ──────────────────────────────────────────────────────────────────
export type TransferParams = {
  pactId: string;
  dstAddress: string;
  tokenId: string; // "BASE_USDC"
  amount: number; // USDC minor units (6 decimals)
  chainId: string; // "BASE"
  apiKey: string;
  apiUrl: string;
};

export type TransferResult =
  | { success: true; txHash: string }
  | { success: false; error: string };

/**
 * Fire-and-forget Treasury → Spending USDC 转账。
 *
 * 调用方不 await —— 本函数内部自行管理全部错误处理。
 * 直接在 process.env 环境下执行 caw 二进制，不走 CAW profile HOME。
 */
export async function runTreasuryTransfer(
  params: TransferParams
): Promise<TransferResult> {
  // 🧪 MOCK模式：跳过真实 CAW 二进制调用
  if (process.env.TREASURY_MOCK === "true") {
    console.log("[treasury] 🧪 MOCK模式：模拟转账成功");
    treasuryStatus = "transferring";
    await new Promise((r) => setTimeout(r, 3000)); // 模拟3秒链上延迟
    treasuryStatus = "completed";
    treasuryLastAmount = params.amount;
    treasuryLastTransferAt = new Date().toISOString();
    lastTransferAt = Date.now();
    const txHash = "0xMOCK_TX_HASH_" + Date.now();
    console.log(`[treasury] ✅ 互充完成，txHash: ${txHash}`);
    return { success: true, txHash };
  }

  // 冷却检查
  const now = Date.now();
  if (transferInProgress) {
    console.log("[treasury] 转账已在执行中，跳过");
    return { success: false, error: "TRANSFER_COOLDOWN" };
  }
  if (now - lastTransferAt < TRANSFER_COOLDOWN_MS) {
    console.log("[treasury] 转账冷却中，跳过");
    return { success: false, error: "TRANSFER_COOLDOWN" };
  }

  transferInProgress = true;
  treasuryStatus = "transferring";
  treasuryLastAmount = params.amount;
  treasuryLastTransferAt = null;

  const args = [
    "tx",
    "transfer",
    "--pact-id",
    params.pactId,
    "--dst-address",
    params.dstAddress,
    "--token-id",
    params.tokenId,
    "--amount",
    String(params.amount),
    "--chain-id",
    params.chainId,
    "--api-key",
    params.apiKey,
    "--api-url",
    params.apiUrl,
  ];

  console.log(
    `[treasury] 开始转账: ${params.amount} ${params.tokenId} → ${params.dstAddress.slice(0, 6)}...${params.dstAddress.slice(-4)}`
  );

  try {
    const binary = resolveCawBinary();
    const { stdout, stderr } = await execFileAsync(binary, args, {
      env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: "0" },
      timeout: TRANSFER_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });

    const combined = stdout + stderr;

    // 尝试匹配 tx hash (多种 caw 输出格式)
    const txHashMatch =
      combined.match(/transaction_hash["':\s]+([0-9a-fA-Fx]+)/) ||
      combined.match(/tx_hash["':\s]+([0-9a-fA-Fx]+)/) ||
      combined.match(/["']id["']:\s*["']([0-9a-fA-Fx]+)["']/) ||
      combined.match(/(0x[a-fA-F0-9]{64})/);

    // 检查拒绝或错误
    const denied =
      /denied|rejected|insufficient|error|fail/i.test(combined) &&
      !txHashMatch;

    if (txHashMatch && !denied) {
      const txHash = txHashMatch[1];
      treasuryStatus = "completed";
      treasuryLastAmount = params.amount;
      treasuryLastTransferAt = new Date().toISOString();
      lastTransferAt = Date.now();

      console.log(`[treasury] ✅ 转账成功: txHash=${txHash}`);
      return { success: true, txHash };
    }

    // 解析错误信息
    const errorMsg =
      stderr.trim().slice(0, 500) || stdout.trim().slice(0, 500) || "未知错误";
    treasuryStatus = "failed";
    lastTransferAt = Date.now();

    console.log(`[treasury] ❌ 转账失败: ${errorMsg}`);
    return { success: false, error: errorMsg };
  } catch (err: unknown) {
    const msg =
      err instanceof Error ? err.message : String(err);
    treasuryStatus = "failed";
    lastTransferAt = Date.now();

    console.log(`[treasury] ❌ 转账异常: ${msg}`);
    return { success: false, error: msg };
  } finally {
    transferInProgress = false;
  }
}

function resolveCawBinary(): string {
  if (process.env.CAW_CLI_PATH) {
    return process.env.CAW_CLI_PATH;
  }
  const homeBinary = join(
    homedir(),
    ".cobo-agentic-wallet",
    "bin",
    "caw"
  );
  return existsSync(homeBinary) ? homeBinary : "caw";
}
