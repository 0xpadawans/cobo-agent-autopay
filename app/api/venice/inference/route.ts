import { requireCurrentUser } from "@/lib/auth/session";
import { errorJson, okJson, readJson } from "@/lib/http";
import { getVeniceApiKeyForUser, getVeniceModelForUser } from "@/lib/config/store";
import { runVeniceChatCompletion } from "@/lib/venice/client";
import { appendInferenceLog } from "@/lib/store/venice-file-logs";

export const dynamic = "force-dynamic";

type InferenceBody = {
  prompt?: string;
  systemPrompt?: string;
  model?: string;
};

export async function POST(request: Request) {
  const startTime = Date.now();
  let prompt = "";
  let model = "";
  let userId = "";

  try {
    const user = await requireCurrentUser();
    userId = user.id;

    // Read body early so prompt is captured in logs on any error
    const body = await readJson<InferenceBody>(request);
    prompt = body.prompt?.trim() || "";
    model = body.model?.trim() || "";

    const apiKey = getVeniceApiKeyForUser(user.id);
    if (!apiKey) {
      throw new Error("VENICE_API_KEY is required for Venice inference.");
    }

    if (!prompt) {
      return errorJson(new Error("prompt is required"), 400);
    }

    const result = await runVeniceChatCompletion({
      prompt,
      systemPrompt: body.systemPrompt,
      model: body.model ?? getVeniceModelForUser(user.id),
      apiKey
    });

    const durationMs = Date.now() - startTime;
    const usage = (result as Record<string, unknown>)?.usage as Record<string, number> | undefined;

    // Log success
    appendInferenceLog({
      userId,
      prompt,
      model: model || "default",
      response: "ok",
      inputTokens: usage?.prompt_tokens ?? null,
      outputTokens: usage?.completion_tokens ?? null,
      status: "completed",
      creditsCharged: 0,
      durationMs
    });

    return okJson({ ok: true, result });
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : "unknown error";

    // Log failure
    if (userId) {
      appendInferenceLog({
        userId,
        prompt,
        model: model || "default",
        response: "",
        inputTokens: null,
        outputTokens: null,
        status: "failed",
        errorMessage,
        creditsCharged: 0,
        durationMs
      });
    }

    return errorJson(error);
  }
}
