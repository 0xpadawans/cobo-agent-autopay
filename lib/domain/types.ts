export type CawAuthorizationStatus =
  | "pending_user_approval"
  | "active"
  | "expired"
  | "revoked";

export type CawAuthorizationPurpose = "credits_payment" | "venice_x402" | "blockrun_x402";

export type TopupOrderStatus =
  | "pending_policy"
  | "caw_submitted"
  | "chain_pending"
  | "pending_approval"
  | "approval_expired"
  | "credited"
  | "failed";

export type AgentUsageStatus = "completed" | "failed_insufficient_balance";

export type AgentStatus = "active" | "paused" | "disabled";

export type AgentRunStatus =
  | "running"
  | "waiting_for_venice_balance"
  | "completed"
  | "failed";

export type VeniceTopupOrderStatus =
  | "pending_policy"
  | "caw_submitted"
  | "payment_submitted"
  | "payment_failed"
  | "balance_pending"
  | "balance_confirmed"
  | "failed";

export type User = {
  id: string;
  email: string;
  coboId?: string;
  coboIdBoundAt?: string;
  cawWalletId?: string;
  cawWalletAddress?: string;
  createdAt: string;
};

export type CreditAccount = {
  userId: string;
  balanceCredits: number;
  lowBalanceThresholdCredits: number;
  autoTopupCredits: number;
  updatedAt: string;
};

export type CawRuntimeCredential = {
  id: string;
  userId: string;
  walletId: string;
  walletAddress: string;
  walletName?: string;
  agentId: string;
  apiUrl: string;
  cawHomePath?: string;
  keyVersion: number;
  lastVerifiedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type CawAuthorization = {
  id: string;
  userId: string;
  purpose: CawAuthorizationPurpose;
  walletAddress: string;
  pactId: string;
  pactApiKey?: string;
  status: CawAuthorizationStatus;
  singleLimitUsdcMinor: number;
  dailyLimitUsdcMinor: number;
  monthlyLimitUsdcMinor: number;
  spentTodayUsdcMinor: number;
  spentMonthUsdcMinor: number;
  dailyWindowStart: string;
  monthlyWindowStart: string;
  expiresAt: string;
  createdAt: string;
};

export type LedgerEntry = {
  id: string;
  userId: string;
  type: "opening_grant" | "agent_usage" | "auto_topup";
  creditsDelta: number;
  balanceAfterCredits: number;
  orderId?: string;
  usageEventId?: string;
  usdcMinor?: number;
  txHash?: string;
  createdAt: string;
};

export type TopupOrder = {
  id: string;
  userId: string;
  walletAddress: string;
  status: TopupOrderStatus;
  reason: string;
  orderId: string;
  onchainOrderId: string;
  amountUsdcMinor: number;
  credits: number;
  txHash?: string;
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
  creditedAt?: string;
};

export type AgentUsageEvent = {
  id: string;
  userId: string;
  taskName: string;
  prompt: string;
  estimatedCredits: number;
  creditsCharged: number;
  status: AgentUsageStatus;
  createdAt: string;
};

export type Agent = {
  id: string;
  userId: string;
  name: string;
  status: AgentStatus;
  veniceAutoTopup: boolean;
  veniceTopupUsdMinor: number;
  createdAt: string;
  updatedAt: string;
};

export type AgentRun = {
  id: string;
  userId: string;
  agentId: string;
  taskName: string;
  prompt: string;
  status: AgentRunStatus;
  resumeAfterOrderId?: string;
  lastError?: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type VeniceTopupOrder = {
  id: string;
  userId: string;
  agentId?: string;
  agentRunId?: string;
  walletAddress: string;
  pactId: string;
  status: VeniceTopupOrderStatus;
  usdAmount: number;
  amountUsdcMinor: number;
  responseStatus?: number;
  responseBodyPreview?: string;
  txHash?: string;
  balanceCanConsume?: boolean;
  balanceUsd?: number;
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
  paymentSubmittedAt?: string;
  balanceCheckedAt?: string;
};

export type CawPairingSession = {
  code: string;
  status: "generated" | "paired" | "expired";
  expiresAt: string;
  createdAt: string;
};

export type CawOnboardingStatus =
  | "not_started"
  | "waiting_input"
  | "running"
  | "wallet_active"
  | "failed";

export type CawOnboardingPrompt = {
  id: string;
  label?: string;
  message?: string;
  type?: string;
  required?: boolean;
  secret?: boolean;
  options?: string[];
};

export type CawWalletOnboardingSession = {
  userId: string;
  sessionId?: string;
  status: CawOnboardingStatus;
  phase?: string;
  walletStatus?: string;
  needsInput: boolean;
  prompts: CawOnboardingPrompt[];
  nextAction?: string;
  lastError?: string;
  agentName?: string;
  apiUrl?: string;
  walletId?: string;
  walletName?: string;
  agentId?: string;
  createdAt: string;
  updatedAt: string;
};

export type UserGuardrails = {
  singleLimitUsdcMinor: number;
  dailyLimitUsdcMinor: number;
  reviewThresholdUsdcMinor: number;
  allowedAddresses: string[];
  allowedChains: string[];
  generatedBy: "system_default" | "ai_questionnaire" | "ai_direct";
  updatedAt: string;
};

export type PaymentStats = {
  spent24hUsdcMinor: number;
  spent30dUsdcMinor: number;
  txCount24h: number;
  txCount30d: number;
  automaticPayments: number;
  manualApprovalPayments: number;
};

export type PactDetails = {
  reviewIfAmountUsdcMinor: number;
  denyIfAmountUsdcMinor: number;
  completionTimeElapsedDays: number;
  completionAmountSpentUsdcMinor: number;
  remainingUsdcMinor: number;
  txCount24hLimit: number;
  amount24hLimitUsdcMinor: number;
};

export type DashboardSnapshot = {
  user: User;
  account: CreditAccount;
  authorization?: CawAuthorization;
  veniceAuthorization?: CawAuthorization;
  cawRuntimeCredential?: CawRuntimeCredential;
  pairingSession?: CawPairingSession;
  cawOnboardingSession?: CawWalletOnboardingSession;
  guardrails: UserGuardrails;
  paymentStats: PaymentStats;
  pendingApprovals: TopupOrder[];
  pactDetails?: PactDetails;
  topupOrders: TopupOrder[];
  veniceTopupOrders: VeniceTopupOrder[];
  agents: Agent[];
  agentRuns: AgentRun[];
  ledgerEntries: LedgerEntry[];
  usageEvents: AgentUsageEvent[];
  network: {
    chainId: number;
    name: string;
    usdcAddress: string;
  };
  pricing: {
    creditsPerUsdc: number;
  };
};
