// Runtime config: DB-backed (memory now) with env fallback.
// Lets dashboard front-end override env values without code/config changes.

import { getRuntimeConfigValue, setRuntimeConfig } from "@/lib/store/venice";
import type { RuntimeConfigKey } from "@/lib/venice/types";

const globalUserRuntimeConfig = globalThis as typeof globalThis & {
  __agentToTokenUserRuntimeConfig?: Map<string, Map<RuntimeConfigKey, string>>;
};

function userRuntimeConfigStore() {
  if (!globalUserRuntimeConfig.__agentToTokenUserRuntimeConfig) {
    globalUserRuntimeConfig.__agentToTokenUserRuntimeConfig = new Map();
  }
  return globalUserRuntimeConfig.__agentToTokenUserRuntimeConfig;
}

function getUserRuntimeConfigValue(userId: string, key: RuntimeConfigKey): string | undefined {
  return userRuntimeConfigStore().get(userId)?.get(key);
}

function setUserRuntimeConfig(userId: string, key: RuntimeConfigKey, value: string) {
  const store = userRuntimeConfigStore();
  const userStore = store.get(userId) ?? new Map<RuntimeConfigKey, string>();
  userStore.set(key, value);
  store.set(userId, userStore);
}

/**
 * Resolve a config value with the following priority:
 *   1. RuntimeConfig (in-memory, set by dashboard)
 *   2. process.env[ENV_KEY] (e.g. VENICE_API_KEY)
 *   3. fallback arg
 */
export function resolveConfig(
  key: RuntimeConfigKey,
  envKey: string,
  fallback?: string
): string | undefined {
  return getRuntimeConfigValue(key) ?? process.env[envKey] ?? fallback;
}

export function writeConfig(key: RuntimeConfigKey, value: string) {
  return setRuntimeConfig(key, value);
}

// Venice-specific helpers

export function getVeniceApiKey(): string | undefined {
  return resolveConfig("venice_api_key", "VENICE_API_KEY");
}

export function getVeniceApiKeyForUser(userId: string): string | undefined {
  return getUserRuntimeConfigValue(userId, "venice_api_key") ?? process.env.VENICE_API_KEY;
}

export function setVeniceApiKey(value: string) {
  return writeConfig("venice_api_key", value);
}

export function setVeniceApiKeyForUser(userId: string, value: string) {
  setUserRuntimeConfig(userId, "venice_api_key", value);
}

export function getVeniceModel(): string {
  return resolveConfig("venice_inference_model", "VENICE_INFERENCE_MODEL", "llama-3.3-70b")!;
}

export function getVeniceModelForUser(userId: string): string {
  return getUserRuntimeConfigValue(userId, "venice_inference_model")
    ?? process.env.VENICE_INFERENCE_MODEL
    ?? "llama-3.3-70b";
}

export function setVeniceModel(value: string) {
  return writeConfig("venice_inference_model", value);
}

export function setVeniceModelForUser(userId: string, value: string) {
  setUserRuntimeConfig(userId, "venice_inference_model", value);
}

export function getVeniceBaseUrl(): string {
  return process.env.VENICE_BASE_URL || "https://api.venice.ai";
}

export function getLowBalanceThresholdUsd(): number {
  const raw = resolveConfig("venice_low_balance_threshold_usd", "VENICE_LOW_BALANCE_THRESHOLD_USD", "5");
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
}

export function getLowBalanceThresholdUsdForUser(userId: string): number {
  const raw = getUserRuntimeConfigValue(userId, "venice_low_balance_threshold_usd")
    ?? process.env.VENICE_LOW_BALANCE_THRESHOLD_USD
    ?? "5";
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
}

export function setLowBalanceThresholdUsdForUser(userId: string, value: number) {
  setUserRuntimeConfig(userId, "venice_low_balance_threshold_usd", String(value));
}

export function getDefaultTopupUsd(): number {
  const raw = resolveConfig("x402_topup_default_usd", "X402_TOPUP_DEFAULT_USD", "5");
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
}

export function getDefaultTopupUsdForUser(userId: string): number {
  const raw = getUserRuntimeConfigValue(userId, "x402_topup_default_usd")
    ?? process.env.X402_TOPUP_DEFAULT_USD
    ?? "5";
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
}

/** Mask an API key for safe display: "ven_***last4" */
export function maskApiKey(key: string | undefined): string {
  if (!key) return "";
  if (key.length <= 8) return "***";
  return `${key.slice(0, 4)}***${key.slice(-4)}`;
}
