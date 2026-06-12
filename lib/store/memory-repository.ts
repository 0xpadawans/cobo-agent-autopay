import { createHash } from "node:crypto";
import { CREDITS_PER_USDC, getConfiguredChain } from "@/lib/domain/constants";
import type {
  Agent,
  AgentRun,
  AgentUsageEvent,
  CawAuthorization,
  CawAuthorizationPurpose,
  CawRuntimeCredential,
  CreditAccount,
  DashboardSnapshot,
  LedgerEntry,
  TopupOrder,
  VeniceTopupOrder,
  User,
  CawPairingSession,
  CawWalletOnboardingSession
} from "@/lib/domain/types";
import {
  createId,
  createUserWithDefaults,
  db,
  getActiveAuthorization,
  nowIso,
  requireCreditAccount,
  requireUser,
  snapshotForUser
} from "@/lib/store/memory";
import type { ChainEventRecord, CreditRepository } from "@/lib/store/repository";

const pendingTopupStatuses: TopupOrder["status"][] = [
  "pending_policy",
  "caw_submitted",
  "chain_pending",
  "pending_approval"
];

export const memoryRepository: CreditRepository = {
  createId,
  nowIso,
  async snapshotForUser(userId: string): Promise<DashboardSnapshot> {
    return snapshotForUser(userId);
  },
  async getOrCreateUserByEmail(email: string): Promise<User> {
    const normalizedEmail = normalizeEmail(email);
    const existing = [...db.users.values()].find((user) => user.email === normalizedEmail);
    return existing ?? createUserWithDefaults(normalizedEmail);
  },
  async findUserByCoboId(coboId: string): Promise<User | undefined> {
    const normalizedCoboId = coboId.toLowerCase();
    return [...db.users.values()].find(
      (user) => user.coboId?.toLowerCase() === normalizedCoboId
    );
  },
  async findUserByCawWalletId(walletId: string): Promise<User | undefined> {
    return [...db.users.values()].find((user) => user.cawWalletId === walletId);
  },
  async findUserByCawWalletAddress(walletAddress: string): Promise<User | undefined> {
    const normalizedWallet = walletAddress.toLowerCase();
    return [...db.users.values()].find(
      (user) => user.cawWalletAddress?.toLowerCase() === normalizedWallet
    );
  },
  async requireUser(userId: string): Promise<User> {
    return requireUser(userId);
  },
  async requireCreditAccount(userId: string): Promise<CreditAccount> {
    return requireCreditAccount(userId);
  },
  async updateCreditAccount(account: CreditAccount): Promise<CreditAccount> {
    db.creditAccounts.set(account.userId, account);
    return account;
  },
  async updateUser(user: User): Promise<User> {
    db.users.set(user.id, user);
    return user;
  },
  async getActiveAuthorization(
    userId: string,
    purpose?: CawAuthorizationPurpose
  ): Promise<CawAuthorization | undefined> {
    return getActiveAuthorization(userId, purpose);
  },
  async createAuthorization(authorization: CawAuthorization): Promise<CawAuthorization> {
    db.cawAuthorizations.set(authorization.id, authorization);
    return authorization;
  },
  async updateAuthorization(authorization: CawAuthorization): Promise<CawAuthorization> {
    db.cawAuthorizations.set(authorization.id, authorization);
    return authorization;
  },
  async createPairingSession(
    userId: string,
    session: CawPairingSession
  ): Promise<CawPairingSession> {
    db.pairingSessions.set(userId, session);
    return session;
  },
  async upsertCawRuntimeCredential(input): Promise<CawRuntimeCredential> {
    const now = nowIso();
    const existing = db.cawRuntimeCredentials.get(input.userId);
    const credential: CawRuntimeCredential = {
      id: existing?.id ?? createId("crc"),
      userId: input.userId,
      walletId: input.walletId,
      walletAddress: input.walletAddress,
      walletName: input.walletName,
      agentId: input.agentId,
      apiUrl: input.apiUrl,
      cawHomePath: input.cawHomePath,
      keyVersion: input.keyVersion ?? existing?.keyVersion ?? 1,
      lastVerifiedAt: input.lastVerifiedAt,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    db.cawRuntimeCredentials.set(input.userId, credential);
    return credential;
  },
  async getCawRuntimeCredential(userId: string): Promise<CawRuntimeCredential | undefined> {
    return db.cawRuntimeCredentials.get(userId);
  },
  async getCawOnboardingSession(
    userId: string
  ): Promise<CawWalletOnboardingSession | undefined> {
    return db.cawOnboardingSessions.get(userId);
  },
  async upsertCawOnboardingSession(
    session: CawWalletOnboardingSession
  ): Promise<CawWalletOnboardingSession> {
    db.cawOnboardingSessions.set(session.userId, session);
    return session;
  },
  async getOrCreateAgent(input: { userId: string; name: string }): Promise<Agent> {
    const existing = [...db.agents.values()].find(
      (agent) => agent.userId === input.userId && agent.name === input.name
    );
    if (existing) {
      return existing;
    }
    const now = nowIso();
    const agent: Agent = {
      id: createId("agt"),
      userId: input.userId,
      name: input.name,
      status: "active",
      veniceAutoTopup: true,
      veniceTopupUsdMinor: 1_000_000,
      createdAt: now,
      updatedAt: now
    };
    db.agents.set(agent.id, agent);
    return agent;
  },
  async updateAgent(agent: Agent): Promise<Agent> {
    const updated = { ...agent, updatedAt: nowIso() };
    db.agents.set(agent.id, updated);
    return updated;
  },
  async createAgentRun(
    input: Omit<AgentRun, "id" | "startedAt" | "updatedAt" | "completedAt">
  ): Promise<AgentRun> {
    const now = nowIso();
    const run: AgentRun = {
      ...input,
      id: createId("run"),
      startedAt: now,
      updatedAt: now
    };
    db.agentRuns.set(run.id, run);
    return run;
  },
  async updateAgentRun(run: AgentRun): Promise<AgentRun> {
    const updated = { ...run, updatedAt: nowIso() };
    db.agentRuns.set(run.id, updated);
    return updated;
  },
  async createVeniceTopupOrder(
    input: Omit<VeniceTopupOrder, "id" | "createdAt" | "updatedAt">
  ): Promise<VeniceTopupOrder> {
    const now = nowIso();
    const order: VeniceTopupOrder = {
      ...input,
      id: createId("vto"),
      createdAt: now,
      updatedAt: now
    };
    db.veniceTopupOrders.set(order.id, order);
    return order;
  },
  async updateVeniceTopupOrder(order: VeniceTopupOrder): Promise<VeniceTopupOrder> {
    const updated = { ...order, updatedAt: nowIso() };
    db.veniceTopupOrders.set(order.id, updated);
    return updated;
  },
  async createUsageEvent(
    input: Omit<AgentUsageEvent, "id" | "createdAt">
  ): Promise<AgentUsageEvent> {
    const usageEvent: AgentUsageEvent = {
      ...input,
      id: createId("use"),
      createdAt: nowIso()
    };
    db.usageEvents.push(usageEvent);
    return usageEvent;
  },
  async appendLedgerEntry(input: Omit<LedgerEntry, "id" | "createdAt">): Promise<LedgerEntry> {
    const entry: LedgerEntry = {
      ...input,
      id: createId("led"),
      createdAt: nowIso()
    };
    db.ledgerEntries.push(entry);
    return entry;
  },
  async findPendingTopupOrder(userId: string): Promise<TopupOrder | undefined> {
    return [...db.topupOrders.values()].find(
      (order) => order.userId === userId && pendingTopupStatuses.includes(order.status)
    );
  },
  async listPendingTopupOrders(userId: string): Promise<TopupOrder[]> {
    return [...db.topupOrders.values()]
      .filter((order) => order.userId === userId && pendingTopupStatuses.includes(order.status))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  },
  async createTopupOrder(
    input: Omit<TopupOrder, "id" | "orderId" | "onchainOrderId" | "createdAt" | "updatedAt">
  ): Promise<TopupOrder> {
    const createdAt = nowIso();
    const orderId = createId("ord");
    const order: TopupOrder = {
      ...input,
      id: createId("top"),
      orderId,
      onchainOrderId: orderIdToBytes32(orderId),
      createdAt,
      updatedAt: createdAt
    };
    db.topupOrders.set(order.id, order);
    return order;
  },
  async updateTopupOrder(order: TopupOrder): Promise<TopupOrder> {
    db.topupOrders.set(order.id, order);
    return order;
  },
  async findTopupOrderByOrderId(input: {
    orderId?: string;
    onchainOrderId?: string;
  }): Promise<TopupOrder | undefined> {
    return [...db.topupOrders.values()].find(
      (candidate) =>
        candidate.orderId === input.orderId || candidate.onchainOrderId === input.onchainOrderId
    );
  },
  async findTopupOrderByTxHash(input: {
    userId: string;
    txHash: string;
  }): Promise<TopupOrder | undefined> {
    const normalizedTxHash = input.txHash.toLowerCase();
    return [...db.topupOrders.values()].find(
      (candidate) =>
        candidate.userId === input.userId &&
        candidate.txHash?.toLowerCase() === normalizedTxHash
    );
  },
  async hasChainEvent(eventId: string): Promise<boolean> {
    return db.chainEventsSeen.has(eventId);
  },
  async markChainEventSeen(event: ChainEventRecord): Promise<boolean> {
    if (db.chainEventsSeen.has(event.eventId)) {
      return false;
    }
    db.chainEventsSeen.add(event.eventId);
    return true;
  }
};

function orderIdToBytes32(orderId: string) {
  return `0x${createHash("sha256").update(orderId).digest("hex")}`;
}

export const memorySnapshotNetwork = {
  chainId: getConfiguredChain().id,
  name: getConfiguredChain().name,
  usdcAddress: getConfiguredChain().usdcAddress,
  creditsPerUsdc: CREDITS_PER_USDC
};

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}
