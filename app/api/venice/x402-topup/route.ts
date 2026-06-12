import { requireCurrentUser } from "@/lib/auth/session";
import { errorJson, okJson, readJson } from "@/lib/http";
import {
  discoverVeniceX402Requirements,
  getOrCreateVeniceX402TopupRequest,
  pickBaseUsdcAccept,
  runVeniceX402Topup
} from "@/lib/venice/topup";

export const dynamic = "force-dynamic";

type TopupBody = {
  amountUsdc?: number;
  usdAmount?: number;
  amountUsdcMinor?: number;
  agentId?: string;
  agentRunId?: string;
  confirmed?: boolean;
};

export async function GET() {
  try {
    await requireCurrentUser();
    const requirements = await discoverVeniceX402Requirements();
    return okJson({
      ok: true,
      requirements,
      selected: pickBaseUsdcAccept(requirements)
    });
  } catch (error) {
    return errorJson(error);
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireCurrentUser();
    const body = await readJson<TopupBody>(request);
    if (body.confirmed !== true) {
      throw new Error("Explicit confirmation is required before executing a real Venice x402 top-up.");
    }
    const usdAmount = parseUsdAmount(body);
    const topupRequest = await getOrCreateVeniceX402TopupRequest({
      userId: user.id,
      usdAmount
    });
    return okJson(await runVeniceX402Topup({
      userId: user.id,
      agentId: body.agentId,
      agentRunId: body.agentRunId,
      walletAddress: topupRequest.walletAddress,
      pactId: topupRequest.pactId,
      usdAmount: topupRequest.usdAmount
    }));
  } catch (error) {
    return errorJson(error);
  }
}

function parseUsdAmount(body: Partial<TopupBody>) {
  if (Number.isFinite(body.usdAmount) && Number(body.usdAmount) > 0) {
    return Number(body.usdAmount);
  }
  if (Number.isFinite(body.amountUsdc) && Number(body.amountUsdc) > 0) {
    return Number(body.amountUsdc);
  }
  if (Number.isFinite(body.amountUsdcMinor) && Number(body.amountUsdcMinor) > 0) {
    return Number(body.amountUsdcMinor) / 1_000_000;
  }
  const configured = Number(process.env.VENICE_X402_DEFAULT_USDC_MINOR || 1_000_000);
  return Number.isFinite(configured) && configured > 0 ? configured / 1_000_000 : 1;
}
