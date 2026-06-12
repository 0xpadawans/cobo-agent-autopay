import type {
  AgentUsageEvent,
  Agent,
  AgentRun,
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

export type ChainEventRecord = {
  eventId: string;
  txHash?: string;
  logIndex?: number;
  orderId?: string;
};

export type CreditRepository = {
  createId(prefix: string): string;
  nowIso(): string;
  snapshotForUser(userId: string): Promise<DashboardSnapshot>;
  getOrCreateUserByEmail(email: string): Promise<User>;
  findUserByCoboId(coboId: string): Promise<User | undefined>;
  findUserByCawWalletId(walletId: string): Promise<User | undefined>;
  findUserByCawWalletAddress(walletAddress: string): Promise<User | undefined>;
  requireUser(userId: string): Promise<User>;
  requireCreditAccount(userId: string): Promise<CreditAccount>;
  updateCreditAccount(account: CreditAccount): Promise<CreditAccount>;
  updateUser(user: User): Promise<User>;
  getActiveAuthorization(
    userId: string,
    purpose?: CawAuthorizationPurpose
  ): Promise<CawAuthorization | undefined>;
  createAuthorization(authorization: CawAuthorization): Promise<CawAuthorization>;
  updateAuthorization(authorization: CawAuthorization): Promise<CawAuthorization>;
  createPairingSession(userId: string, session: CawPairingSession): Promise<CawPairingSession>;
  upsertCawRuntimeCredential(input: {
    userId: string;
    walletId: string;
    walletAddress: string;
    walletName?: string;
    agentId: string;
    apiUrl: string;
    apiKeyEncrypted: string;
    cawHomePath?: string;
    keyVersion?: number;
    lastVerifiedAt?: string;
  }): Promise<CawRuntimeCredential>;
  getCawRuntimeCredential(userId: string): Promise<CawRuntimeCredential | undefined>;
  getCawOnboardingSession(userId: string): Promise<CawWalletOnboardingSession | undefined>;
  upsertCawOnboardingSession(
    session: CawWalletOnboardingSession
  ): Promise<CawWalletOnboardingSession>;
  getOrCreateAgent(input: {
    userId: string;
    name: string;
  }): Promise<Agent>;
  updateAgent(agent: Agent): Promise<Agent>;
  createAgentRun(
    input: Omit<AgentRun, "id" | "startedAt" | "updatedAt" | "completedAt">
  ): Promise<AgentRun>;
  updateAgentRun(run: AgentRun): Promise<AgentRun>;
  createVeniceTopupOrder(
    input: Omit<VeniceTopupOrder, "id" | "createdAt" | "updatedAt">
  ): Promise<VeniceTopupOrder>;
  updateVeniceTopupOrder(order: VeniceTopupOrder): Promise<VeniceTopupOrder>;
  createUsageEvent(input: Omit<AgentUsageEvent, "id" | "createdAt">): Promise<AgentUsageEvent>;
  appendLedgerEntry(input: Omit<LedgerEntry, "id" | "createdAt">): Promise<LedgerEntry>;
  findPendingTopupOrder(userId: string): Promise<TopupOrder | undefined>;
  listPendingTopupOrders(userId: string): Promise<TopupOrder[]>;
  createTopupOrder(
    input: Omit<TopupOrder, "id" | "orderId" | "onchainOrderId" | "createdAt" | "updatedAt">
  ): Promise<TopupOrder>;
  updateTopupOrder(order: TopupOrder): Promise<TopupOrder>;
  findTopupOrderByOrderId(input: {
    orderId?: string;
    onchainOrderId?: string;
  }): Promise<TopupOrder | undefined>;
  findTopupOrderByTxHash(input: {
    userId: string;
    txHash: string;
  }): Promise<TopupOrder | undefined>;
  hasChainEvent(eventId: string): Promise<boolean>;
  markChainEventSeen(event: ChainEventRecord): Promise<boolean>;
};
