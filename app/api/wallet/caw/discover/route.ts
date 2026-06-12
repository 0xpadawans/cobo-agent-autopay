// GET /api/wallet/caw/discover
//
// Runs `caw wallet list` against the user's actual CAW profile directory
// (under their real HOME) and returns a sanitized list of wallets they
// can bind to this dashboard. The browser uses this to show "Available
// Wallets" in the CAW integration panel and lets the user pick one
// without editing .env or remembering UUIDs.
//
// Response: { ok: true, wallets: CawWalletSummary[] } on success,
// { ok: false, error: string } on failure.

import { NextResponse } from "next/server";
import type { CawWalletSummary } from "@/lib/venice/types";
import { requireCurrentUser } from "@/lib/auth/session";
import { getCawHomePathForUser, runCawCli } from "@/lib/caw/cli";

function inferEnv(apiUrl: string): "prod" | "dev" | "unknown" {
  if (apiUrl.includes("dev.cobo.com") || apiUrl.includes("sandbox")) {
    return "dev";
  }
  if (apiUrl.includes("api.agenticwallet.cobo.com")) {
    return "prod";
  }
  return "unknown";
}

export async function GET() {
  const user = await requireCurrentUser();
  const debug = {
    cawHome: getCawHomePathForUser(user.id)
  };

  try {
    // caw wallet list returns a top-level JSON array; caw pact list returns
    // an object with a `result` envelope. We try array first, then object.
    const proc = await runCawCli(user.id, ["wallet", "list"], { timeoutMs: 15_000 });
    if (proc.exitCode !== 0) {
      return NextResponse.json(
        {
          ok: false,
          error: "caw wallet list failed",
          rawStderr: proc.stderr.slice(0, 500),
          status: proc.exitCode,
          debug
        },
        { status: 500 }
      );
    }

    let rawArray: Array<Record<string, unknown>> = [];
    let rawObject: { result?: Array<Record<string, unknown>> } | null = null;
    let parseError: string | null = null;
    try {
      const parsed = JSON.parse(proc.stdout);
      if (Array.isArray(parsed)) {
        rawArray = parsed;
      } else if (parsed && typeof parsed === "object") {
        rawObject = parsed as { result?: Array<Record<string, unknown>> };
        if (Array.isArray(rawObject.result)) {
          rawArray = rawObject.result;
        }
      }
    } catch (e) {
      parseError = e instanceof Error ? e.message : String(e);
    }
    if (parseError) {
      return NextResponse.json(
        {
          ok: false,
          error: "caw wallet list returned non-JSON",
          parseError,
          rawStdout: proc.stdout.slice(0, 1000),
          rawStderr: proc.stderr.slice(0, 500),
          status: proc.exitCode,
          debug
        },
        { status: 500 }
      );
    }

    const rawWallets = rawArray;
    const wallets: CawWalletSummary[] = rawWallets.map((w) => {
      const apiUrl = String(w.api_url ?? "");
      const env = inferEnv(apiUrl);
      return {
        walletUuid: String(w.wallet_uuid ?? ""),
        walletName: String(w.wallet_name ?? w.wallet_name ?? "unknown"),
        agentId: String(w.agent_id ?? ""),
        agentName: String(w.agent_name ?? "unknown"),
        apiUrl,
        env,
        isActive: Boolean(w.active),
        status: String(w.status ?? "unknown"),
        onboardedAt: String(w.onboarded_at ?? "")
      };
    });

    return NextResponse.json({ ok: true, wallets, debug });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg, debug }, { status: 500 });
  }
}
