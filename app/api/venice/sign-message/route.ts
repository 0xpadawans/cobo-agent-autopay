import { NextRequest } from "next/server";
import { requireCurrentUser } from "@/lib/auth/session";
import { getCreditRepository } from "@/lib/store";
import { getCawIntegrationStatus } from "@/lib/domain/services";
import { signSiweXWithCaw, encodeSiweXHeader } from "@/lib/venice/siwe";
import { errorJson, okJson, readJson } from "@/lib/http";

export const dynamic = "force-dynamic";

const CHAIN_NUMERIC: Record<string, number> = {
  BASE_ETH: 8453,
  BASE_SEPOLIA: 84532
};

export async function POST(request: NextRequest) {
  try {
    const user = await requireCurrentUser();
    const body = await readJson<{ uri?: string; chainId?: string }>(request);

    const cawStatus = await getCawIntegrationStatus(user.id);
    const runtime = cawStatus.runtime;
    if (runtime.mode !== "http") {
      return errorJson(
        new Error(
          "EIP-712 SIWE-X signing requires real CAW mode (CAW_MODE=http, with paired wallet + active Pact)."
        ),
        400
      );
    }

    const repo = getCreditRepository();
    const snapshot = await repo.snapshotForUser(user.id);
    const walletAddress = snapshot.user.cawWalletAddress ?? runtime.walletAddress;
    if (!walletAddress) {
      return errorJson(new Error("Connect a CAW wallet first."), 400);
    }
    const auth = snapshot.authorization;
    if (!auth || auth.status !== "active") {
      return errorJson(new Error("Create and approve an active Pact first."), 400);
    }

    const chainId = body.chainId ?? runtime.chainId;
    const chainNumericId = CHAIN_NUMERIC[chainId] ?? 8453;
    const uri = body.uri ?? "https://api.venice.ai/api/v1/chat/completions";

    const payload = await signSiweXWithCaw({
      userId: user.id,
      pactId: auth.pactId,
      chainId,
      walletAddress,
      uri,
      chainNumericId
    });

    const headerValue = encodeSiweXHeader(payload);

    return okJson({
      ok: true,
      walletAddress,
      chainId,
      uri,
      headerName: "X-Sign-In-With-X",
      headerValue,
      decoded: {
        message: payload.typedData.message,
        signature: payload.signature,
        txId: payload.txId
      }
    });
  } catch (error) {
    return errorJson(error);
  }
}
