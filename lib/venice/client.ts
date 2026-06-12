export type VeniceRequestInput = {
  method?: "GET" | "POST";
  path: string;
  body?: unknown;
  apiKey?: string;
  passthrough?: boolean;
};

export type VeniceResponse = {
  status: number;
  headers: Headers;
  body: unknown;
  text: string;
};

export class VeniceApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export function getVeniceBaseUrl() {
  return (process.env.VENICE_BASE_URL || "https://api.venice.ai").replace(/\/+$/, "");
}

export function getVeniceApiKey() {
  return process.env.VENICE_API_KEY || "";
}

export function getVeniceModel() {
  return process.env.VENICE_INFERENCE_MODEL || "llama-3.3-70b";
}

export async function veniceRequest(input: VeniceRequestInput): Promise<VeniceResponse> {
  const headers: Record<string, string> = {
    Accept: "application/json"
  };
  const apiKey = input.apiKey ?? getVeniceApiKey();
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  if (input.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(`${getVeniceBaseUrl()}${normalizePath(input.path)}`, {
    method: input.method ?? "GET",
    headers,
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
    cache: "no-store"
  });
  const text = await response.text();
  const body = parseJsonOrText(text);

  if (!response.ok && !input.passthrough) {
    throw new VeniceApiError(extractVeniceMessage(body, response), response.status, body);
  }

  return {
    status: response.status,
    headers: response.headers,
    body,
    text
  };
}

export async function fetchVeniceBillingBalance(apiKey?: string) {
  const response = await veniceRequest({ path: "/api/v1/billing/balance", apiKey });
  return response.body;
}

export async function fetchVeniceX402Balance(walletAddress: string) {
  const response = await veniceRequest({
    path: `/api/v1/x402/balance?address=${encodeURIComponent(walletAddress)}`,
    passthrough: true
  });
  return {
    status: response.status,
    raw: response.body
  };
}

export async function runVeniceChatCompletion(input: {
  prompt: string;
  systemPrompt?: string;
  model?: string;
  apiKey?: string;
}) {
  const messages = [];
  if (input.systemPrompt?.trim()) {
    messages.push({ role: "system", content: input.systemPrompt.trim() });
  }
  messages.push({ role: "user", content: input.prompt.trim() });

  const response = await veniceRequest({
    method: "POST",
    path: "/api/v1/chat/completions",
    apiKey: input.apiKey,
    body: {
      model: input.model?.trim() || getVeniceModel(),
      messages,
      stream: false
    }
  });
  return response.body;
}

function normalizePath(path: string) {
  return path.startsWith("/") ? path : `/${path}`;
}

function parseJsonOrText(text: string) {
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function extractVeniceMessage(body: unknown, response: Response) {
  if (typeof body === "string" && body) {
    return body.slice(0, 300);
  }
  if (isRecord(body)) {
    const message = body.error || body.message || body.detail;
    if (typeof message === "string") {
      return message;
    }
  }
  return `Venice API ${response.status} ${response.statusText}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
