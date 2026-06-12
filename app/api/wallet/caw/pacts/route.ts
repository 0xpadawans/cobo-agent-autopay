// GET /api/wallet/caw/pacts?status=active
//
// Runs `caw pact list` and returns a sanitized summary list of pacts so
// the dashboard can show whether the user has any active pacts covering
// the chains / tokens that Venice x402 needs (Base USDC on BASE_ETH).
//
// Currently the user's 3 active pacts are Sepolia-only (single tx up to
// 0.05 USDC), so the dashboard should surface a "no Base mainnet pact"
// warning when a Venice top-up is attempted.

import { NextResponse } from "next/server";
import type { CawPactSummary } from "@/lib/venice/types";
import { requireCurrentUser } from "@/lib/auth/session";
import { runCawCli } from "@/lib/caw/cli";
import { getCreditRepository } from "@/lib/store";

function inferStatus(value: unknown): CawPactSummary["status"] {
  if (typeof value !== "string") return "unknown";
  const normalized = value.toLowerCase();
  if (
    normalized === "active" ||
    normalized === "pending_approval" ||
    normalized === "completed" ||
    normalized === "expired" ||
    normalized === "revoked" ||
    normalized === "rejected"
  ) {
    return normalized;
  }
  return "unknown";
}

export async function GET(request: Request) {
  const user = await requireCurrentUser();
  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? "active";
  if (!["active", "pending_approval", "completed", "expired", "revoked", "rejected"].includes(status)) {
    return NextResponse.json({ ok: false, error: "invalid status" }, { status: 400 });
  }
  const snapshot = await getCreditRepository().snapshotForUser(user.id);

  try {
    const proc = await runCawCli(user.id, ["pact", "list", "--status", status, "--limit", "50"], {
      timeoutMs: 15_000
    });
    if (proc.exitCode !== 0) {
      throw new Error(proc.stderr || `caw pact list failed with status ${proc.exitCode}`);
    }
    const raw = proc.stdout ?? "";
    const data = JSON.parse(raw) as {
      result?: { pacts?: Array<Record<string, unknown>> };
    };
    const pactsRaw = Array.isArray(data?.result?.pacts)
      ? data.result.pacts
      : [];

    const pacts: CawPactSummary[] = pactsRaw.map((p) => {
      const remaining = (p.remaining ?? {}) as Record<string, unknown>;
      const operator = (p.operator ?? {}) as Record<string, unknown>;
      return {
        id: String(p.id ?? ""),
        name: String(p.name ?? ""),
        intent: String(p.intent ?? ""),
        status: inferStatus(p.status),
        isDefault: Boolean(p.is_default),
        expiresAt: String(p.expires_at ?? ""),
        remaining: {
          timeRemainingSeconds:
            typeof remaining.time_remaining_seconds === "number"
              ? remaining.time_remaining_seconds
              : undefined,
          txCountRemaining:
            typeof remaining.tx_count_remaining === "number"
              ? remaining.tx_count_remaining
              : undefined
        },
        operatorName: String(operator.name ?? ""),
        raw: p
      };
    });

    // Detect whether any pact covers Base mainnet (chain id BASE_ETH)
    // and USDC contract 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.
    // Venice sends those in its 402 challenge; without a matching pact
    // the caw fetch will be denied by policy.
    const hasBaseUsdcPact = pacts.some((p) => {
      const raw = p.raw as Record<string, unknown>;
      const intent = String(raw.intent ?? "").toLowerCase();
      const name = String(raw.name ?? "").toLowerCase();
      return (
        intent.includes("BASE_ETH") ||
        intent.includes("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913") ||
        name.includes("BASE_ETH") ||
        name.includes("base")
      );
    });

    return NextResponse.json({
      ok: true,
      status,
      pacts,
      hasBaseUsdcPact,
      boundWallet: {
        walletUuid: snapshot.user.cawWalletId,
        walletName: snapshot.cawRuntimeCredential?.walletName,
        source: "user"
      }
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      {
        ok: false,
        error: msg,
        boundWallet: {
          walletUuid: snapshot.user.cawWalletId,
          walletName: snapshot.cawRuntimeCredential?.walletName,
          source: "user"
        }
      },
      { status: 500 }
    );
  }
}
