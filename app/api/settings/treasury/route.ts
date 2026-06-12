// app/api/settings/treasury/route.ts
// 用户级 Treasury Agent 配置管理（加密存储）
// GET: 读取当前配置（API Key 脱敏）
// POST: 保存配置

import { requireCurrentUser } from "@/lib/auth/session";
import { okJson, errorJson, readJson } from "@/lib/http";
import { setUserSecret, getUserSecrets, getUserSecret } from "@/lib/secrets/store";
import { maskApiKey } from "@/lib/config/store";

export const dynamic = "force-dynamic";

const TREASURY_KEYS = [
  "TREASURY_API_KEY",
  "TREASURY_API_URL",
  "TREASURY_PACT_ID",
  "TREASURY_TOPUP_AMOUNT",
] as const;

type TreasuryConfigBody = {
  treasuryApiKey?: string;
  treasuryApiUrl?: string;
  treasuryPactId?: string;
  treasuryTopupAmount?: number;
};

export async function GET() {
  const user = await requireCurrentUser();
  const secrets = await getUserSecrets(user.id, [...TREASURY_KEYS]);

  const apiKey = secrets["TREASURY_API_KEY"];

  return okJson({
    treasuryApiKeyMasked: apiKey ? maskApiKey(apiKey) : "",
    hasTreasuryApiKey: Boolean(apiKey),
    treasuryApiUrl: secrets["TREASURY_API_URL"] ?? "",
    treasuryPactId: secrets["TREASURY_PACT_ID"] ?? "",
    treasuryTopupAmount: Number(secrets["TREASURY_TOPUP_AMOUNT"] || 20),
  });
}

export async function POST(request: Request) {
  const user = await requireCurrentUser();
  const body = await readJson<TreasuryConfigBody>(request);

  if (body.treasuryApiKey !== undefined) {
    await setUserSecret(user.id, "TREASURY_API_KEY", body.treasuryApiKey);
  }
  if (body.treasuryApiUrl !== undefined) {
    await setUserSecret(user.id, "TREASURY_API_URL", body.treasuryApiUrl);
  }
  if (body.treasuryPactId !== undefined) {
    await setUserSecret(user.id, "TREASURY_PACT_ID", body.treasuryPactId);
  }
  if (body.treasuryTopupAmount !== undefined) {
    const amount = Number(body.treasuryTopupAmount);
    if (!Number.isFinite(amount) || amount < 1 || amount > 1000) {
      return errorJson("treasuryTopupAmount must be a number between 1 and 1000");
    }
    await setUserSecret(user.id, "TREASURY_TOPUP_AMOUNT", String(amount));
  }

  return okJson({ ok: true });
}
