// lib/secrets/store.ts
// 通用加密配置存储：用户级密钥（API Key / Pact ID 等）AES-256-GCM 加密存 SQLite。
//
// 密钥派生：从 NEXTAUTH_SECRET 派生 32 字节 AES 密钥（SHA-256）。
// 加密值格式：base64(iv:12字节 + ciphertext + authTag:16字节)
//
// PS: 项目已有 NEXTAUTH_SECRET（NextAuth 必需），无需引入新环境变量。

import { PrismaClient } from "@prisma/client";
import { randomBytes, createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { resolve } from "node:path";

// 独立 SQLite 连接，不受 DATABASE_URL 影响
const DB_PATH = resolve(process.cwd(), "prisma/dev.db");

function withDb<T>(fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  const db = new PrismaClient({
    datasources: { db: { url: `file:${DB_PATH}` } },
  });
  return fn(db).finally(() => db.$disconnect());
}

// ── 密钥派生 ───────────────────────────────────────────────────────────────
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // GCM 推荐 12 字节
const AUTH_TAG_LENGTH = 16;

function deriveKey(): Buffer {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error(
      "[secrets] NEXTAUTH_SECRET is required for encrypting user secrets. " +
      "Set it in .env or the deployment environment."
    );
  }
  // SHA-256 派生 32 字节 AES 密钥
  return createHash("sha256").update(secret).digest();
}

function encrypt(plaintext: string): string {
  const key = deriveKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf-8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  // 格式: iv + ciphertext + authTag
  return Buffer.concat([iv, encrypted, authTag]).toString("base64");
}

function decrypt(encoded: string): string {
  const key = deriveKey();
  const buf = Buffer.from(encoded, "base64");
  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(buf.length - AUTH_TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH, buf.length - AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext) + decipher.final("utf-8");
}

// ── 公开 API ───────────────────────────────────────────────────────────────

/**
 * 加密存储一个用户级密钥/配置项。
 * 如果同 userId + key 已存在，则更新 value。
 */
export async function setUserSecret(
  userId: string,
  key: string,
  value: string
): Promise<void> {
  const encrypted = encrypt(value);
  await withDb((db) =>
    db.userSecret.upsert({
      where: { userId_key: { userId, key } },
      create: { userId, key, value: encrypted },
      update: { value: encrypted },
    })
  );
}

/**
 * 读取并解密一个用户级密钥/配置项。
 * 不存在时返回 null，不抛异常。
 */
export async function getUserSecret(
  userId: string,
  key: string
): Promise<string | null> {
  try {
    const row = await withDb((db) =>
      db.userSecret.findUnique({
        where: { userId_key: { userId, key } },
      })
    );
    if (!row) return null;
    return decrypt(row.value);
  } catch {
    return null;
  }
}

/**
 * 批量读取多个密钥（一次查询避免多次 DB 往返）。
 * 返回 { [key]: decryptedValue | null }
 */
export async function getUserSecrets(
  userId: string,
  keys: string[]
): Promise<Record<string, string | null>> {
  const rows = await withDb((db) =>
    db.userSecret.findMany({
      where: { userId, key: { in: keys } },
    })
  );
  const map: Record<string, string | null> = {};
  for (const key of keys) {
    const row = rows.find((r) => r.key === key);
    if (row) {
      try {
        map[key] = decrypt(row.value);
      } catch {
        map[key] = null;
      }
    } else {
      map[key] = null;
    }
  }
  return map;
}

/**
 * 删除一个用户级密钥/配置项。
 */
export async function deleteUserSecret(
  userId: string,
  key: string
): Promise<void> {
  try {
    await withDb((db) =>
      db.userSecret.delete({
        where: { userId_key: { userId, key } },
      })
    );
  } catch {
    // 删除不存在的数据视为成功
  }
}
