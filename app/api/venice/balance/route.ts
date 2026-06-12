import { requireCurrentUser } from "@/lib/auth/session";
import { getVeniceApiKeyForUser } from "@/lib/config/store";
import { errorJson, okJson } from "@/lib/http";
import { fetchVeniceBillingBalance } from "@/lib/venice/client";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await requireCurrentUser();
    return okJson({
      ok: true,
      balance: await fetchVeniceBillingBalance(getVeniceApiKeyForUser(user.id))
    });
  } catch (error) {
    return errorJson(error);
  }
}
