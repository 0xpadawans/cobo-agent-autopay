import { NextRequest } from "next/server";
import { requireCurrentUser } from "@/lib/auth/session";
import {
  getVeniceApiKeyForUser,
  getVeniceModelForUser,
  getLowBalanceThresholdUsdForUser,
  getDefaultTopupUsdForUser,
  maskApiKey,
  setVeniceApiKeyForUser,
  setVeniceModelForUser
} from "@/lib/config/store";
import { errorJson, okJson, readJson } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await requireCurrentUser();
    const apiKey = getVeniceApiKeyForUser(user.id);
    return okJson({
      veniceApiKeyConfigured: Boolean(apiKey),
      veniceApiKeyMasked: maskApiKey(apiKey),
      veniceModel: getVeniceModelForUser(user.id),
      lowBalanceThresholdUsd: getLowBalanceThresholdUsdForUser(user.id),
      defaultTopupUsd: getDefaultTopupUsdForUser(user.id)
    });
  } catch (error) {
    return errorJson(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireCurrentUser();
    const body = await readJson<{ veniceApiKey?: string; veniceModel?: string }>(request);
    const updated: string[] = [];
    if (typeof body.veniceApiKey === "string" && body.veniceApiKey.trim()) {
      setVeniceApiKeyForUser(user.id, body.veniceApiKey.trim());
      updated.push("venice_api_key");
    }
    if (typeof body.veniceModel === "string" && body.veniceModel.trim()) {
      setVeniceModelForUser(user.id, body.veniceModel.trim());
      updated.push("venice_inference_model");
    }
    const apiKey = getVeniceApiKeyForUser(user.id);
    return okJson({
      ok: true,
      updated,
      veniceApiKeyConfigured: Boolean(apiKey),
      veniceApiKeyMasked: maskApiKey(apiKey),
      veniceModel: getVeniceModelForUser(user.id)
    });
  } catch (error) {
    return errorJson(error);
  }
}
