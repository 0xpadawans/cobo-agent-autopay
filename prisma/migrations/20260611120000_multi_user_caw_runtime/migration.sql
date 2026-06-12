-- CreateTable
CREATE TABLE "caw_runtime_credentials" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "walletName" TEXT,
    "agentId" TEXT NOT NULL,
    "apiUrl" TEXT NOT NULL,
    "apiKeyEncrypted" TEXT NOT NULL,
    "cawHomePath" TEXT,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "lastVerifiedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "caw_runtime_credentials_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "agents" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "veniceAutoTopup" BOOLEAN NOT NULL DEFAULT true,
    "veniceTopupUsdMinor" INTEGER NOT NULL DEFAULT 1000000,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "agents_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "agent_runs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "taskName" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "resumeAfterOrderId" TEXT,
    "lastError" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "completedAt" DATETIME,
    CONSTRAINT "agent_runs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "agent_runs_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "agent_runs_resumeAfterOrderId_fkey" FOREIGN KEY ("resumeAfterOrderId") REFERENCES "venice_topup_orders" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "venice_topup_orders" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "agentId" TEXT,
    "agentRunId" TEXT,
    "walletAddress" TEXT NOT NULL,
    "pactId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "usdAmount" REAL NOT NULL,
    "amountUsdcMinor" INTEGER NOT NULL,
    "responseStatus" INTEGER,
    "responseBodyPreview" TEXT,
    "txHash" TEXT,
    "balanceCanConsume" BOOLEAN,
    "balanceUsd" REAL,
    "failureReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "paymentSubmittedAt" DATETIME,
    "balanceCheckedAt" DATETIME,
    CONSTRAINT "venice_topup_orders_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "venice_topup_orders_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "venice_topup_orders_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "agent_runs" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "caw_runtime_credentials_userId_key" ON "caw_runtime_credentials"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "caw_runtime_credentials_walletId_key" ON "caw_runtime_credentials"("walletId");

-- CreateIndex
CREATE UNIQUE INDEX "caw_runtime_credentials_walletAddress_key" ON "caw_runtime_credentials"("walletAddress");

-- CreateIndex
CREATE INDEX "caw_runtime_credentials_agentId_idx" ON "caw_runtime_credentials"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "agents_userId_name_key" ON "agents"("userId", "name");

-- CreateIndex
CREATE INDEX "agents_userId_status_idx" ON "agents"("userId", "status");

-- CreateIndex
CREATE INDEX "agent_runs_userId_agentId_status_idx" ON "agent_runs"("userId", "agentId", "status");

-- CreateIndex
CREATE INDEX "agent_runs_resumeAfterOrderId_idx" ON "agent_runs"("resumeAfterOrderId");

-- CreateIndex
CREATE INDEX "venice_topup_orders_userId_status_idx" ON "venice_topup_orders"("userId", "status");

-- CreateIndex
CREATE INDEX "venice_topup_orders_userId_agentId_status_idx" ON "venice_topup_orders"("userId", "agentId", "status");

-- CreateIndex
CREATE INDEX "venice_topup_orders_agentRunId_idx" ON "venice_topup_orders"("agentRunId");
