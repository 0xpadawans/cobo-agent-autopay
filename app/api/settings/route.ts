// app/api/settings/route.ts
// Read/write runtime config settings — in-memory for now, DB schema in later iteration.
import { okJson, errorJson, readJson } from "@/lib/http";
import { getR34SweepHeartbeatStatus } from "@/lib/r34-sweep-heartbeat";
import { requireCurrentUser } from "@/lib/auth/session";
import {
  getLowBalanceThresholdUsdForUser,
  setLowBalanceThresholdUsdForUser
} from "@/lib/config/store";

export const dynamic = "force-dynamic";

// In-memory settings store scoped by user (survives HMR via globalThis)
declare global {
  // eslint-disable-next-line no-var
  var __AUTOPAY_SETTINGS__: Map<string, Record<string, unknown>> | undefined;
}

function getSettings(userId: string): Record<string, unknown> {
  if (!globalThis.__AUTOPAY_SETTINGS__) {
    globalThis.__AUTOPAY_SETTINGS__ = new Map();
  }
  const existing = globalThis.__AUTOPAY_SETTINGS__.get(userId);
  if (existing) {
    return existing;
  }
  const created: Record<string, unknown> = {};
  globalThis.__AUTOPAY_SETTINGS__.set(userId, created);
  return created;
}

export async function GET() {
  const user = await requireCurrentUser();
  const store = getSettings(user.id);
  const hb = getR34SweepHeartbeatStatus();
  return okJson({
    veniceBalanceThreshold:
      store.veniceBalanceThreshold ?? getLowBalanceThresholdUsdForUser(user.id) ?? hb.veniceBalanceThreshold ?? 5,
    ...store
  });
}

export async function POST(request: Request) {
  const user = await requireCurrentUser();
  const body = await readJson<{ veniceBalanceThreshold?: number }>(request);
  if (body.veniceBalanceThreshold !== undefined) {
    const raw = body.veniceBalanceThreshold;
    const num = typeof raw === "number" && Number.isFinite(raw) ? raw : Number(raw);
    if (!Number.isFinite(num) || num < 0 || num > 1000) {
      return errorJson("veniceBalanceThreshold must be a number between 0 and 1000");
    }
    getSettings(user.id).veniceBalanceThreshold = num;
    setLowBalanceThresholdUsdForUser(user.id, num);
  }
  return okJson({ ok: true, settings: { ...getSettings(user.id) } });
}
