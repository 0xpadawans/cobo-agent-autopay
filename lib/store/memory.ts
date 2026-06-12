import {
  CREDITS_PER_USDC,
  DEFAULT_CREDIT_ACCOUNT,
  DEFAULT_GUARDRAILS,
  DEFAULT_SPEND_POLICY,
  DEMO_USER_EMAIL,
  DEMO_USER_ID,
  getConfiguredCawChainId,
  getConfiguredChain
} from "@/lib/domain/constants";
import type {
  Agent,
  AgentRun,
  AgentUsageEvent,
  CawAuthorization,
  CawAuthorizationPurpose,
  CawRuntimeCredential,
  CreditAccount,
  CawPairingSession,
  CawWalletOnboardingSession,
  DashboardSnapshot,
  LedgerEntry,
  TopupOrder,
  VeniceTopupOrder,
  User
} from "@/lib/domain/types";

type AgentDb = {
  users: Map<string, User>;
  creditAccounts: Map<string, CreditAccount>;
  cawAuthorizations: Map<string, CawAuthorization>;
  cawRuntimeCredentials: Map<string, CawRuntimeCredential>;
  agents: Map<string, Agent>;
  agentRuns: Map<string, AgentRun>;
  veniceTopupOrders: Map<string, VeniceTopupOrder>;
  ledgerEntries: LedgerEntry[];
  topupOrders: Map<string, TopupOrder>;
  usageEvents: AgentUsageEvent[];
  chainEventsSeen: Set<string>;
  pairingSessions: Map<string, CawPairingSession>;
  cawOnboardingSessions: Map<string, CawWalletOnboardingSession>;
};

const globalStore = globalThis as typeof globalThis & {
  __agentToTokenDb?: AgentDb;
};

export function nowIso() {
  return new Date().toISOString();
}

export function createId(prefix: string) {
  const uuid = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `${prefix}_${uuid.replaceAll("-", "").slice(0, 16)}`;
}

function createInitialDb(): AgentDb {
  const createdAt = nowIso();
  const user: User = {
    id: DEMO_USER_ID,
    email: DEMO_USER_EMAIL,
    createdAt
  };
  const account: CreditAccount = {
    userId: DEMO_USER_ID,
    balanceCredits: DEFAULT_CREDIT_ACCOUNT.openingBalanceCredits,
    lowBalanceThresholdCredits: DEFAULT_CREDIT_ACCOUNT.lowBalanceThresholdCredits,
    autoTopupCredits: DEFAULT_CREDIT_ACCOUNT.autoTopupCredits,
    updatedAt: createdAt
  };

  return {
    users: new Map([[DEMO_USER_ID, user]]),
    creditAccounts: new Map([[DEMO_USER_ID, account]]),
    cawAuthorizations: new Map(),
    cawRuntimeCredentials: new Map(),
    agents: new Map(),
    agentRuns: new Map(),
    veniceTopupOrders: new Map(),
    ledgerEntries: [
      {
        id: createId("led"),
        userId: DEMO_USER_ID,
        type: "opening_grant",
        creditsDelta: DEFAULT_CREDIT_ACCOUNT.openingBalanceCredits,
        balanceAfterCredits: DEFAULT_CREDIT_ACCOUNT.openingBalanceCredits,
        createdAt
      }
    ],
    topupOrders: new Map(),
    usageEvents: [],
    chainEventsSeen: new Set(),
    pairingSessions: new Map(),
    cawOnboardingSessions: new Map()
  };
}

export const db = globalStore.__agentToTokenDb ?? createInitialDb();
globalStore.__agentToTokenDb = db;

export function createUserWithDefaults(email: string) {
  const createdAt = nowIso();
  const id = createId("usr");
  const user: User = {
    id,
    email,
    createdAt
  };
  const account: CreditAccount = {
    userId: id,
    balanceCredits: DEFAULT_CREDIT_ACCOUNT.openingBalanceCredits,
    lowBalanceThresholdCredits: DEFAULT_CREDIT_ACCOUNT.lowBalanceThresholdCredits,
    autoTopupCredits: DEFAULT_CREDIT_ACCOUNT.autoTopupCredits,
    updatedAt: createdAt
  };

  db.users.set(id, user);
  db.creditAccounts.set(id, account);
  db.ledgerEntries.push({
    id: createId("led"),
    userId: id,
    type: "opening_grant",
    creditsDelta: DEFAULT_CREDIT_ACCOUNT.openingBalanceCredits,
    balanceAfterCredits: DEFAULT_CREDIT_ACCOUNT.openingBalanceCredits,
    createdAt
  });

  return user;
}

export function requireUser(userId: string) {
  const user = db.users.get(userId);
  if (!user) {
    throw new Error(`Unknown user: ${userId}`);
  }
  return user;
}

export function requireCreditAccount(userId: string) {
  const account = db.creditAccounts.get(userId);
  if (!account) {
    throw new Error(`Missing credit account for user: ${userId}`);
  }
  return account;
}

export function getActiveAuthorization(
  userId: string,
  purpose: CawAuthorizationPurpose = "credits_payment"
) {
  const auths = [...db.cawAuthorizations.values()].filter(
    (authorization) => authorization.userId === userId && authorization.purpose === purpose
  );
  return auths.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

export function snapshotForUser(userId: string): DashboardSnapshot {
  const user = requireUser(userId);
  const account = requireCreditAccount(userId);
  const authorization = getActiveAuthorization(userId);
  const veniceAuthorization = getActiveAuthorization(userId, "venice_x402");
  const publicAuthorization = authorization
    ? {
        ...authorization,
        pactApiKey: undefined
      }
    : undefined;
  const publicVeniceAuthorization = veniceAuthorization
    ? {
        ...veniceAuthorization,
        pactApiKey: undefined
      }
    : undefined;
  const chain = getConfiguredChain();
  const topupOrders = [...db.topupOrders.values()]
    .filter((order) => order.userId === userId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const veniceTopupOrders = [...db.veniceTopupOrders.values()]
    .filter((order) => order.userId === userId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const agents = [...db.agents.values()]
    .filter((agent) => agent.userId === userId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const agentRuns = [...db.agentRuns.values()]
    .filter((run) => run.userId === userId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const creditedOrders = topupOrders.filter((order) => order.status === "credited");
  const now = Date.now();
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const monthAgo = now - 30 * 24 * 60 * 60 * 1000;
  const credited24h = creditedOrders.filter((order) => Date.parse(order.updatedAt) >= dayAgo);
  const credited30d = creditedOrders.filter((order) => Date.parse(order.updatedAt) >= monthAgo);

  return {
    user,
    account,
    authorization: publicAuthorization,
    veniceAuthorization: publicVeniceAuthorization,
    cawRuntimeCredential: db.cawRuntimeCredentials.get(userId),
    pairingSession: db.pairingSessions.get(userId),
    cawOnboardingSession: db.cawOnboardingSessions.get(userId),
    guardrails: {
      singleLimitUsdcMinor:
        authorization?.singleLimitUsdcMinor ?? DEFAULT_SPEND_POLICY.singleLimitUsdcMinor,
      dailyLimitUsdcMinor:
        authorization?.dailyLimitUsdcMinor ?? DEFAULT_SPEND_POLICY.dailyLimitUsdcMinor,
      reviewThresholdUsdcMinor: DEFAULT_GUARDRAILS.reviewThresholdUsdcMinor,
      allowedAddresses: user.cawWalletAddress ? [user.cawWalletAddress] : [],
      allowedChains: [getConfiguredCawChainId()],
      generatedBy: "system_default",
      updatedAt: authorization?.createdAt ?? user.createdAt
    },
    paymentStats: {
      spent24hUsdcMinor: credited24h.reduce((total, order) => total + order.amountUsdcMinor, 0),
      spent30dUsdcMinor: credited30d.reduce((total, order) => total + order.amountUsdcMinor, 0),
      txCount24h: credited24h.length,
      txCount30d: credited30d.length,
      automaticPayments: creditedOrders.filter((order) => order.reason !== "manual").length,
      manualApprovalPayments: topupOrders.filter((order) => order.status === "pending_approval")
        .length
    },
    pendingApprovals: topupOrders
      .filter((order) => order.status === "pending_approval")
      .slice(0, 12),
    pactDetails: authorization
      ? {
          reviewIfAmountUsdcMinor: DEFAULT_GUARDRAILS.reviewThresholdUsdcMinor,
          denyIfAmountUsdcMinor: authorization.singleLimitUsdcMinor,
          completionTimeElapsedDays: Math.max(
            0,
            Math.ceil((Date.parse(authorization.expiresAt) - Date.now()) / (24 * 60 * 60 * 1000))
          ),
          completionAmountSpentUsdcMinor: authorization.monthlyLimitUsdcMinor,
          remainingUsdcMinor: Math.max(
            0,
            authorization.monthlyLimitUsdcMinor - authorization.spentMonthUsdcMinor
          ),
          txCount24hLimit: DEFAULT_GUARDRAILS.rolling24hTxCountLimit,
          amount24hLimitUsdcMinor: DEFAULT_GUARDRAILS.rolling24hAmountUsdcMinor
        }
      : undefined,
    topupOrders: topupOrders.slice(0, 12),
    veniceTopupOrders: veniceTopupOrders.slice(0, 12),
    agents,
    agentRuns: agentRuns.slice(0, 12),
    ledgerEntries: db.ledgerEntries
      .filter((entry) => entry.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 12),
    usageEvents: db.usageEvents
      .filter((event) => event.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 12),
    network: {
      chainId: chain.id,
      name: chain.name,
      usdcAddress: chain.usdcAddress
    },
    pricing: {
      creditsPerUsdc: CREDITS_PER_USDC
    }
  };
}
