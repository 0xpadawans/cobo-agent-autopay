import { requireCurrentUser } from "@/lib/auth/session";
import { runAgentTask } from "@/lib/domain/services";
import { errorJson, okJson, readJson } from "@/lib/http";

export const dynamic = "force-dynamic";

type RunAgentBody = {
  agentId?: string;
  taskName: string;
  prompt: string;
};

export async function POST(request: Request) {
  try {
    const user = await requireCurrentUser();
    const body = await readJson<RunAgentBody>(request);
    return okJson(await runAgentTask({ ...body, userId: user.id }));
  } catch (error) {
    return errorJson(error);
  }
}
