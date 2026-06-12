import { requireCurrentUser } from "@/lib/auth/session";
import { listCawTransactions } from "@/lib/domain/services";
import { errorJson, okJson } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const user = await requireCurrentUser();
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const records = await listCawTransactions({ userId: user.id, limit });

    return okJson({ records });
  } catch (error) {
    return errorJson(error);
  }
}
