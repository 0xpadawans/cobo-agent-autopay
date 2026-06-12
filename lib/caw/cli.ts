import { execFile } from "node:child_process";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { getConfiguredCawChainId, getConfiguredChain } from "@/lib/domain/constants";
import type { CawRuntimeStatus } from "@/lib/caw/gateway";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 1024 * 1024;

export type CawCliPrompt = {
  id: string;
  label?: string;
  message?: string;
  type?: string;
  required?: boolean;
  secret?: boolean;
  options?: string[];
};

export type CawCliOnboardResult = {
  raw: Record<string, unknown>;
  sessionId?: string;
  phase?: string;
  walletStatus?: string;
  needsInput: boolean;
  prompts: CawCliPrompt[];
  nextAction?: string;
  lastError?: string;
  walletId?: string;
  walletName?: string;
  agentId?: string;
  apiUrl?: string;
};

export type CawCliWalletProfile = {
  walletId?: string;
  walletName?: string;
  walletAddress?: string;
  agentId?: string;
  apiUrl?: string;
  walletPaired?: boolean;
  pairTokenStatus?: string;
  walletStatus?: string;
};

export type CawCliProfileCredentials = {
  apiKey: string;
  apiUrl: string;
  agentId?: string;
  walletId?: string;
  walletName?: string;
};

export type CawCliPaymentResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type CawCliPactResult = {
  pactId: string;
  status: "active" | "pending_user_approval" | "expired" | "revoked";
  raw: Record<string, unknown>;
};

export async function runCawOnboard(input: {
  userId: string;
  sessionId?: string;
  agentName?: string;
  apiUrl?: string;
  answers?: Record<string, unknown>;
}) {
  const args = ["onboard"];
  if (input.sessionId) {
    args.push("--session-id", input.sessionId);
  } else if (input.agentName) {
    args.push("--agent-name", input.agentName);
  }
  if (input.apiUrl) {
    args.push("--api-url", input.apiUrl);
  }
  if (input.answers && Object.keys(input.answers).length > 0) {
    args.push("--answers", JSON.stringify(input.answers));
  }

  return normalizeOnboardResult(
    await runCawCliJson<Record<string, unknown>>(input.userId, args, {
      timeoutMs: 120_000
    })
  );
}

export async function readCawCliWalletProfile(userId: string): Promise<CawCliWalletProfile> {
  const [current, status, balance] = await Promise.all([
    runCawCliJson<Record<string, unknown>>(userId, ["wallet", "current"]).catch(() => undefined),
    runCawCliJson<Record<string, unknown>>(userId, ["status"]).catch(() => undefined),
    runCawCliJson<Record<string, unknown>>(userId, ["wallet", "balance", "--limit", "20"]).catch(
      () => undefined
    )
  ]);

  return {
    walletId:
      firstString(current, ["wallet_uuid", "wallet_id", "id"]) ??
      firstString(status, ["wallet_uuid", "wallet_id"]),
    walletName: firstString(current, ["wallet_name", "name"]) ?? firstString(status, ["wallet_name"]),
    walletAddress:
      firstEvmAddress(balance) ??
      firstEvmAddress(current) ??
      firstEvmAddress(status),
    agentId: firstString(current, ["agent_id"]) ?? firstString(status, ["agent_id"]),
    apiUrl: firstString(current, ["api_url"]) ?? firstString(status, ["api_url"]),
    walletPaired: firstBoolean(status, ["wallet_paired"]),
    pairTokenStatus: firstString(status, ["token_status", "pair_token_status"]),
    walletStatus: firstString(status, ["wallet_status", "status"])
  };
}

export async function readCawCliProfileCredentials(
  userId: string,
  walletUuid?: string
): Promise<CawCliProfileCredentials | undefined> {
  const cawHome = getCawHomePathForUser(userId);
  const profilesDir = path.join(cawHome, ".cobo-agentic-wallet", "profiles");
  if (!existsSync(profilesDir)) {
    return undefined;
  }

  let dirs: string[];
  try {
    dirs = await readdir(profilesDir);
  } catch {
    return undefined;
  }

  for (const dir of dirs.filter((entry) => entry.startsWith("profile_caw_agent_"))) {
    try {
      const raw = await readFile(path.join(profilesDir, dir, "credentials"), "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const profileWalletUuid = firstString(parsed, ["wallet_uuid", "wallet_id"]);
      if (walletUuid && profileWalletUuid !== walletUuid) {
        continue;
      }
      const apiKey = firstString(parsed, ["api_key"]);
      const apiUrl = firstString(parsed, ["api_url"]);
      if (!apiKey || !apiUrl) {
        continue;
      }
      return {
        apiKey,
        apiUrl,
        agentId: firstString(parsed, ["agent_id"]),
        walletId: profileWalletUuid,
        walletName: firstString(parsed, ["wallet_name", "name"])
      };
    } catch {
      // Keep scanning other profiles.
    }
  }
  return undefined;
}

export async function getCawWalletInfoFromList(userId: string, walletUuid: string): Promise<{
  walletAddress?: string;
  walletName?: string;
  agentId?: string;
  apiUrl?: string;
  isPaired?: boolean;
} | null> {
  // Read the user's isolated CLI profile, then use the CAW SDK to resolve the wallet address.
  try {
    const result = await runCawCli(userId, ["wallet", "list"], { timeoutMs: 15_000 });
    if (result.exitCode !== 0) return null;
    const wallets: Record<string, unknown>[] = JSON.parse(result.stdout);
    const match = wallets.find((w) => String(w.wallet_uuid ?? "") === walletUuid);
    if (!match) return null;

    const profileDir = String(match.profile_dir ?? "");
    let apiKey = "";
    let apiUrl = String(match.api_url ?? "");
    if (profileDir) {
      try {
        const fs = await import("node:fs/promises");
        const credPath = path.join(profileDir, "credentials");
        const credRaw = await fs.readFile(credPath, "utf-8");
        const cred = JSON.parse(credRaw);
        apiKey = cred.api_key ?? "";
        apiUrl = cred.api_url ?? apiUrl;
      } catch { /* ignore */ }
    }

    // Use the CAW SDK to list wallet addresses (correct API path).
    let walletAddress: string | undefined;
    if (apiKey && apiUrl) {
      try {
        const { Configuration, WalletsApi } = await import("@cobo/agentic-wallet");
        const config = new Configuration({ apiKey, basePath: apiUrl });
        const walletsApi = new WalletsApi(config);
        const resp = await walletsApi.listWalletAddresses(walletUuid);
        const addrs = resp.data?.result;
        const first = Array.isArray(addrs) ? addrs[0] as unknown as Record<string, unknown> : undefined;
        if (first) {
          walletAddress = (first.address ?? first.addr ?? undefined) as string | undefined;
        }
      } catch { /* ignore */ }
    }

    return {
      walletAddress,
      walletName: firstString(match, ["wallet_name"]) ?? undefined,
      agentId: firstString(match, ["agent_id"]) ?? undefined,
      apiUrl: apiUrl || undefined,
      isPaired: Boolean(match.is_paired || match.status === "active"),
    };
  } catch {
    return null;
  }
}

export async function createCawCliPairingCode(userId: string) {
  const raw = await runCawCliJson<Record<string, unknown>>(userId, ["wallet", "pair"]);
  return {
    code: firstString(raw, ["token", "code", "pairing_code"]) ?? "",
    expiresAt:
      firstString(raw, ["expires_at", "expiresAt"]) ??
      new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    status: "generated" as const,
    walletId: firstString(raw, ["wallet_uuid", "wallet_id"]),
    walletName: firstString(raw, ["wallet_name"]),
    agentId: firstString(raw, ["agent_id"]),
    raw
  };
}

export async function getCawCliPairingStatus(userId: string) {
  const raw = await runCawCliJson<Record<string, unknown>>(userId, ["wallet", "pair-status"]);
  const tokenStatus = firstString(raw, ["token_status", "status"]);
  return {
    tokenStatus,
    token: firstString(raw, ["token", "code"]),
    raw
  };
}

export async function submitCawCliPact(input: {
  userId: string;
  name?: string;
  intent: string;
  originalIntent: string;
  executionPlan: string;
  policies: unknown[];
  completionConditions: unknown[];
}) {
  const args = [
    "pact",
    "submit",
    ...(input.name ? ["--name", input.name] : []),
    "--intent",
    input.intent,
    "--original-intent",
    input.originalIntent,
    "--policies",
    JSON.stringify(input.policies),
    "--completion-conditions",
    JSON.stringify(input.completionConditions),
    "--execution-plan",
    input.executionPlan
  ];
  const raw = await runCawCliJson<Record<string, unknown>>(input.userId, args);
  return normalizePactResult(raw);
}

export async function showCawCliPact(input: { userId: string; pactId: string }) {
  const raw = await runCawCliJson<Record<string, unknown>>(input.userId, [
    "pact",
    "show",
    "--pact-id",
    input.pactId
  ]);
  return normalizePactResult(raw);
}

export async function getCawCliRuntimeStatus(input: {
  userId: string;
  walletId?: string;
}): Promise<CawRuntimeStatus> {
  const chain = getConfiguredChain();
  const profile: CawCliWalletProfile | { error: string } = await readCawCliWalletProfile(input.userId).catch((error) => ({
    error: error instanceof Error ? error.message : "Unable to read caw CLI profile."
  }));
  const p = !("error" in profile) ? profile : undefined;

  const walletId = p ? p.walletId ?? input.walletId : input.walletId;
  const walletPaired = p
    ? Boolean(p.walletPaired || p.pairTokenStatus === "paired" || p.pairTokenStatus === "completed")
    : false;
  const status: CawRuntimeStatus = {
    mode: process.env.CAW_MODE === "mock" && process.env.CAW_ALLOW_MOCK === "true" ? "mock" : "http",
    environment: inferCawEnvironment(p ? p.apiUrl ?? "" : ""),
    apiConfigured: Boolean(p),
    walletConfigured: Boolean(walletId),
    walletId,
    walletName: p ? p.walletName : undefined,
    walletStatus: p ? p.walletStatus : undefined,
    walletAddress: p ? p.walletAddress : undefined,
    walletPaired,
    pairTokenStatus: p ? p.pairTokenStatus : undefined,
    chainId: getConfiguredCawChainId(),
    chainName: chain.name,
    faucetTokenId:
      process.env.CAW_FAUCET_TOKEN_ID ||
      (process.env.CHAIN_ENV === "base-mainnet" ? "BASE_ETH_USDC" : "BASE_SEPOLIA_USDC"),
    paymentContractConfigured: Boolean(process.env.PAYMENT_CONTRACT_ADDRESS),
    treasuryConfigured: Boolean(process.env.TREASURY_ADDRESS),
    missing: [],
    error: p ? undefined : ("error" in profile ? profile.error : undefined)
  };
  status.missing = getRuntimeMissingItems(status);
  return status;
}

export async function runCawFetchX402(input: {
  userId: string;
  pactId: string;
  url: string;
  body: Record<string, unknown>;
  network: string;
  maxAmountMinor: number;
}) {
  return runCawCli(input.userId, [
    "fetch",
    input.pactId,
    input.url,
    "--method",
    "POST",
    "--json",
    JSON.stringify(input.body),
    "--protocol",
    "x402",
    "--network",
    input.network,
    "--max-amount",
    String(input.maxAmountMinor),
    "--output",
    "full",
    "--timeout",
    "60"
  ]);
}

export function getCawHomePathForUser(userId: string) {
  return path.join(getCawHomeRoot(), sanitizePathSegment(userId));
}

async function runCawCliJson<T>(
  userId: string,
  args: string[],
  options: { timeoutMs?: number } = {}
): Promise<T> {
  const result = await runCawCli(userId, args, options);
  if (result.exitCode !== 0) {
    throw new Error(safeCliError("caw command failed", result));
  }
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new Error(safeCliError("caw command returned non-JSON output", result));
  }
}

export async function runCawCli(
  userId: string,
  args: string[],
  options: { timeoutMs?: number } = {}
): Promise<CawCliPaymentResult> {
  const home = await ensureCawHome(userId);
  try {
    const { stdout, stderr } = await execFileAsync(resolveCawBinary(), args, {
      env: buildCawEnv(home),
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const caught = error as {
      stdout?: string;
      stderr?: string;
      code?: number;
      signal?: string;
      message?: string;
    };
    return {
      stdout: caught.stdout ?? "",
      stderr: caught.stderr ?? caught.message ?? caught.signal ?? "",
      exitCode: typeof caught.code === "number" ? caught.code : 1
    };
  }
}

async function ensureCawHome(userId: string) {
  const home = path.join(getCawHomeRoot(), sanitizePathSegment(userId));
  await mkdir(home, { recursive: true, mode: 0o700 });
  return home;
}

function getCawHomeRoot() {
  return process.env.CAW_CLI_HOME_ROOT || path.join(process.cwd(), ".caw-cli-homes");
}

function resolveCawBinary() {
  if (process.env.CAW_CLI_PATH) {
    return process.env.CAW_CLI_PATH;
  }
  const homeBinary = path.join(homedir(), ".cobo-agentic-wallet", "bin", "caw");
  return existsSync(homeBinary) ? homeBinary : "caw";
}

function buildCawEnv(home: string) {
  const realHome = homedir();
  const realCawBin = path.join(realHome, ".cobo-agentic-wallet", "bin");
  // Strip proxy env vars to prevent Shadowrocket / local proxy from hijacking
  // DNS and causing TLS ECONNRESET on api.agenticwallet.cobo.com
  const { http_proxy, https_proxy, HTTP_PROXY, HTTPS_PROXY, ALL_PROXY, all_proxy, ...cleanEnv } = process.env;
  return {
    ...cleanEnv,
    HOME: home,
    CAW_CLI_HOME: home,
    PATH: `${realCawBin}${path.delimiter}${process.env.PATH ?? ""}`
  };
}

function normalizeOnboardResult(raw: Record<string, unknown>): CawCliOnboardResult {
  const phase = firstString(raw, ["phase"]);
  const walletStatus = firstString(raw, ["wallet_status", "walletStatus"]);
  return {
    raw,
    sessionId: firstString(raw, ["session_id", "sessionId"]),
    phase,
    walletStatus,
    needsInput: Boolean(firstBoolean(raw, ["needs_input", "needsInput"])),
    prompts: normalizePrompts(raw.prompts),
    nextAction: firstString(raw, ["next_action", "nextAction"]),
    lastError: firstString(raw, ["last_error", "error", "message"]),
    walletId: firstString(raw, ["wallet_uuid", "wallet_id"]),
    walletName: firstString(raw, ["wallet_name"]),
    agentId: firstString(raw, ["agent_id"]),
    apiUrl: firstString(raw, ["api_url"])
  };
}

function normalizePactResult(raw: Record<string, unknown>): CawCliPactResult {
  const pactId = firstString(raw, ["pact_id", "id"]);
  if (!pactId) {
    throw new Error("caw pact output did not include a pact id.");
  }
  const status = normalizePactStatus(firstString(raw, ["status"]));
  return { pactId, status, raw };
}

function normalizePactStatus(status: string | undefined): CawCliPactResult["status"] {
  const normalized = status?.toLowerCase();
  if (normalized === "active") {
    return "active";
  }
  if (normalized === "expired" || normalized === "completed") {
    return "expired";
  }
  if (normalized === "revoked" || normalized === "rejected" || normalized === "withdrawn") {
    return "revoked";
  }
  return "pending_user_approval";
}

function normalizePrompts(value: unknown): CawCliPrompt[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry): CawCliPrompt | undefined => {
      if (!isRecord(entry)) {
        return undefined;
      }
      const id = stringFromRecord(entry, "id");
      if (!id) {
        return undefined;
      }
      return {
        id,
        label: stringFromRecord(entry, "label") ?? stringFromRecord(entry, "name"),
        message: stringFromRecord(entry, "message") ?? stringFromRecord(entry, "description"),
        type: stringFromRecord(entry, "type"),
        required: booleanFromRecord(entry, "required"),
        secret: Boolean(
          booleanFromRecord(entry, "secret") ||
            /key|secret|token|password/i.test(id) ||
            /secret/i.test(stringFromRecord(entry, "type") ?? "")
        ),
        options: arrayOfStrings(entry.options) ?? arrayOfStrings(entry.choices)
      };
    })
    .filter((entry): entry is CawCliPrompt => Boolean(entry));
}

function firstString(value: unknown, keys: string[]): string | undefined {
  const found = findFirst(value, (record) => {
    for (const key of keys) {
      const direct = stringFromRecord(record, key);
      if (direct) {
        return direct;
      }
    }
    return undefined;
  });
  return found;
}

function firstBoolean(value: unknown, keys: string[]): boolean | undefined {
  return findFirst(value, (record) => {
    for (const key of keys) {
      const direct = booleanFromRecord(record, key);
      if (direct !== undefined) {
        return direct;
      }
    }
    return undefined;
  });
}

function firstEvmAddress(value: unknown): string | undefined {
  return findFirst(value, (record) => {
    for (const key of ["address", "addr", "wallet_address", "src_address"]) {
      const direct = stringFromRecord(record, key);
      if (direct && /^0x[a-fA-F0-9]{40}$/.test(direct)) {
        return direct;
      }
    }
    return undefined;
  });
}

function findFirst<T>(
  value: unknown,
  pick: (record: Record<string, unknown>) => T | undefined
): T | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findFirst(entry, pick);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const direct = pick(value);
  if (direct !== undefined) {
    return direct;
  }
  for (const entry of Object.values(value)) {
    const found = findFirst(entry, pick);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function inferCawEnvironment(apiUrl: string): CawRuntimeStatus["environment"] {
  if (apiUrl.includes(".dev.") || apiUrl.includes("dev.") || apiUrl.includes("sandbox")) {
    return "dev";
  }
  if (apiUrl) {
    return "prod";
  }
  return "unknown";
}

function getRuntimeMissingItems(status: Omit<CawRuntimeStatus, "missing">) {
  const missing: string[] = [];
  if (status.mode === "http" && !status.apiConfigured) {
    missing.push("CAW CLI profile");
  }
  if (status.mode === "http" && !status.walletConfigured) {
    missing.push("CAW wallet id");
  }
  if (status.mode === "http" && !status.walletPaired) {
    missing.push("CAW App pairing");
  }
  if (!status.paymentContractConfigured) {
    missing.push("payment contract address");
  }
  if (!status.treasuryConfigured) {
    missing.push("treasury address");
  }
  return missing;
}

function safeCliError(prefix: string, result: CawCliPaymentResult) {
  const stderr = redact(result.stderr).slice(0, 800);
  const stdout = redact(result.stdout).slice(0, 800);
  return `${prefix} (exit ${result.exitCode})${stderr ? `: ${stderr}` : stdout ? `: ${stdout}` : ""}`;
}

function redact(value: string) {
  return value.replace(/(api[_-]?key|token|secret|password|authorization)["'=:\s]+[^"',\s}]+/gi, "$1=[redacted]");
}

function sanitizePathSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
}

function stringFromRecord(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function booleanFromRecord(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function arrayOfStrings(value: unknown) {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value.filter((entry): entry is string => typeof entry === "string");
  return strings.length ? strings : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
