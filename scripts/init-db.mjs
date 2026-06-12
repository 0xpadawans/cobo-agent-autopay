#!/usr/bin/env node
import { existsSync, mkdirSync, openSync, closeSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const envPath = path.join(root, ".env");
const schemaPath = path.join(root, "prisma", "schema.prisma");

function readEnvFile() {
  if (!existsSync(envPath)) {
    return {};
  }
  const entries = {};
  const raw = readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }
    const [key, ...rest] = trimmed.split("=");
    entries[key] = rest.join("=").trim().replace(/^["']|["']$/g, "");
  }
  return entries;
}

function getDatabaseUrl() {
  const env = readEnvFile();
  return process.env.DATABASE_URL || env.DATABASE_URL || "file:./dev.db";
}

function ensureSqliteFile(databaseUrl) {
  if (!databaseUrl.startsWith("file:")) {
    return;
  }

  const rawPath = databaseUrl.slice("file:".length);
  const dbPath = path.resolve(path.dirname(schemaPath), rawPath);
  mkdirSync(path.dirname(dbPath), { recursive: true });

  if (existsSync(dbPath)) {
    console.log(`[db:init] SQLite database exists: ${path.relative(root, dbPath)}`);
    return;
  }

  closeSync(openSync(dbPath, "a"));
  console.log(`[db:init] Created SQLite database file: ${path.relative(root, dbPath)}`);
}

function run(command, args) {
  console.log(`[db:init] ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32"
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const databaseUrl = getDatabaseUrl();
console.log(`[db:init] DATABASE_URL=${databaseUrl}`);
if (!databaseUrl.startsWith("file:")) {
  console.error("[db:init] This branch is configured for Prisma SQLite.");
  console.error('[db:init] Set DATABASE_URL="file:./dev.db" in .env for local demos.');
  process.exit(1);
}
ensureSqliteFile(databaseUrl);
run("npx", ["prisma", "generate"]);
run("npx", ["prisma", "migrate", "deploy"]);
run("npx", ["prisma", "migrate", "status"]);
console.log("[db:init] Database is ready.");
