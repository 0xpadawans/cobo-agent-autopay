// User-scoped CAW runtime binding.
//
// This route intentionally does not write process.env or the old global
// runtime-config store. It exists for compatibility with dashboard callers that
// still hit /runtime-config after discovering a wallet, but all data is resolved
// through the current logged-in user.

import { NextResponse } from "next/server";
import { requireCurrentUser } from "@/lib/auth/session";
import { getCreditRepository } from "@/lib/store";
import { connectCawWallet } from "@/lib/domain/services";
import { readCawCliProfileCredentials } from "@/lib/caw/cli";

function entriesFromCurrent(input: {
  walletUuid?: string;
  walletName?: string;
  apiUrl?: string;
  agentId?: string;
}) {
  const updatedAt = new Date().toISOString();
  return [
    input.walletUuid ? { key: "caw_wallet_uuid", value: input.walletUuid, updatedAt } : undefined,
    input.walletName ? { key: "caw_wallet_name", value: input.walletName, updatedAt } : undefined,
    input.apiUrl ? { key: "caw_api_url", value: input.apiUrl, updatedAt } : undefined,
    input.agentId ? { key: "caw_agent_id", value: input.agentId, updatedAt } : undefined
  ].filter(Boolean);
}

export async function GET(request: Request) {
  const user = await requireCurrentUser();
  const repo = getCreditRepository();
  const url = new URL(request.url);
  const autobind = url.searchParams.get("autobind") === "1";

  if (autobind) {
    const profile = await readCawCliProfileCredentials(user.id);
    if (!profile?.walletId) {
      return NextResponse.json(
        {
          ok: false,
          error: "no user-scoped caw profile found",
          entries: []
        },
        { status: 404 }
      );
    }
    const connected = await connectCawWallet({ userId: user.id, cawWalletId: profile.walletId });
    return NextResponse.json({
      ok: true,
      autobound: true,
      source: "user-caw-cli-profile",
      current: {
        walletUuid: connected.connection.walletId,
        walletName: connected.snapshot.cawRuntimeCredential?.walletName,
        apiUrl: connected.snapshot.cawRuntimeCredential?.apiUrl,
        agentId: connected.snapshot.cawRuntimeCredential?.agentId
      },
      entries: entriesFromCurrent({
        walletUuid: connected.connection.walletId,
        walletName: connected.snapshot.cawRuntimeCredential?.walletName,
        apiUrl: connected.snapshot.cawRuntimeCredential?.apiUrl,
        agentId: connected.snapshot.cawRuntimeCredential?.agentId
      })
    });
  }

  const credential = await repo.getCawRuntimeCredential(user.id);
  return NextResponse.json({
    ok: true,
    source: "user-database",
    current: {
      walletUuid: user.cawWalletId ?? credential?.walletId,
      walletName: credential?.walletName,
      apiUrl: credential?.apiUrl,
      agentId: credential?.agentId
    },
    entries: entriesFromCurrent({
      walletUuid: user.cawWalletId ?? credential?.walletId,
      walletName: credential?.walletName,
      apiUrl: credential?.apiUrl,
      agentId: credential?.agentId
    })
  });
}

export async function POST(request: Request) {
  const user = await requireCurrentUser();
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json body" }, { status: 400 });
  }

  const walletUuid = typeof body.walletUuid === "string" ? body.walletUuid.trim() : "";
  if (!walletUuid) {
    return NextResponse.json(
      { ok: false, error: "walletUuid is required" },
      { status: 400 }
    );
  }

  const connected = await connectCawWallet({ userId: user.id, cawWalletId: walletUuid });
  return NextResponse.json({
    ok: true,
    source: "user-database",
    written: connected.snapshot.cawRuntimeCredential ? 4 : 2,
    current: {
      walletUuid: connected.connection.walletId,
      walletName: connected.snapshot.cawRuntimeCredential?.walletName,
      apiUrl: connected.snapshot.cawRuntimeCredential?.apiUrl,
      agentId: connected.snapshot.cawRuntimeCredential?.agentId
    },
    entries: entriesFromCurrent({
      walletUuid: connected.connection.walletId,
      walletName: connected.snapshot.cawRuntimeCredential?.walletName,
      apiUrl: connected.snapshot.cawRuntimeCredential?.apiUrl,
      agentId: connected.snapshot.cawRuntimeCredential?.agentId
    })
  });
}

export async function DELETE() {
  await requireCurrentUser();
  return NextResponse.json(
    {
      ok: false,
      error: "Clearing user CAW runtime config is not supported from this compatibility route."
    },
    { status: 405 }
  );
}
