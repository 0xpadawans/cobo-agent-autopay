// File-based Venice inference logs storage.
// Solves Next.js dev mode memory isolation where route handlers
// get separate module scopes and in-memory stores don't sync.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const LOGS_FILE = "/tmp/venice-inference-logs.json";
const MAX_LOGS = 50;

type InferenceLogEntry = {
  id: string;
  userId: string;
  prompt: string;
  model: string;
  response: string;
  inputTokens: number | null;
  outputTokens: number | null;
  status: "completed" | "failed";
  errorMessage?: string;
  creditsCharged: number;
  durationMs: number;
  createdAt: string;
};

function ensureDir(filePath: string) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function readLogs(): InferenceLogEntry[] {
  try {
    if (!existsSync(LOGS_FILE)) {
      return [];
    }
    const data = readFileSync(LOGS_FILE, "utf-8");
    return JSON.parse(data) as InferenceLogEntry[];
  } catch {
    return [];
  }
}

function writeLogs(logs: InferenceLogEntry[]) {
  ensureDir(LOGS_FILE);
  writeFileSync(LOGS_FILE, JSON.stringify(logs, null, 2), "utf-8");
}

export function appendInferenceLog(
  input: Omit<InferenceLogEntry, "id" | "createdAt">
): InferenceLogEntry {
  const logs = readLogs();
  const entry: InferenceLogEntry = {
    ...input,
    creditsCharged: input.creditsCharged ?? 0,
    id: `vin_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString()
  };

  logs.unshift(entry);
  if (logs.length > MAX_LOGS) {
    logs.length = MAX_LOGS;
  }

  writeLogs(logs);
  return entry;
}

export function listInferenceLogs(limit = 20, userId?: string): InferenceLogEntry[] {
  const logs = readLogs();
  const scoped = userId ? logs.filter((log) => log.userId === userId) : logs;
  return scoped.slice(0, limit);
}
