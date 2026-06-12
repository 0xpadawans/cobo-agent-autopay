import {
  createCawGateway,
  getCawRuntimeStatus,
  type CawGatewayConfig,
  type CawGateway,
  type CawTransactionRecord
} from "@/lib/caw/gateway";
import {
  createCawCliPairingCode,
  getCawHomePathForUser,
  getCawCliPairingStatus,
  getCawCliRuntimeStatus,
  getCawWalletInfoFromList,
  readCawCliWalletProfile,
  readCawCliProfileCredentials,
  runCawOnboard,
  showCawCliPact,
  submitCawCliPact
} from "@/lib/caw/cli";
import { draftCawPactFromIntent } from "@/lib/caw/pact-drafter";
import {
  BASE_CHAIN,
  CREDITS_PER_USDC,
  DEFAULT_SPEND_POLICY,
  DEMO_USER_ID,
  USDC_MINOR_UNITS,
  getConfiguredCawChainId,
  getConfiguredChain
} from "@/lib/domain/constants";
import { creditsToUsdcMinor, formatUsdc, usdcMinorToCredits } from "@/lib/domain/money";
import type {
  CawAuthorization,
  CawOnboardingStatus,
  CawWalletOnboardingSession,
  TopupOrder,
  User
} from "@/lib/domain/types";
import { getCreditRepository } from "@/lib/store";
import {
  discoverVeniceX402Requirements,
  pickVeniceBaseUsdcAccept,
  runVeniceX402Topup,
  type VeniceX402Accept
} from "@/lib/venice/topup";
import { refreshVeniceBalance } from "@/lib/venice/balance";
import { createPublicClient, formatUnits, getAddress, http } from "viem";
import { base, baseSepolia } from "viem/chains";

type AutoTopupReason = "low_balance" | "insufficient_balance" | "manual" | "x402_resource";
const DEFAULT_X402_RESOURCE_PRICE_USDC_MINOR = 10_000;
const VENICE_CAW_CHAIN_ID = "BASE_ETH";
const VENICE_USDC_TOKEN_ID = "BASE_USDC";
const DEFAULT_VENICE_PACT_LIMITS = {
  singleLimitUsdcMinor: 1 * USDC_MINOR_UNITS,
  dailyLimitUsdcMinor: 5 * USDC_MINOR_UNITS,
  monthlyLimitUsdcMinor: 20 * USDC_MINOR_UNITS,
  validDays: 7
} as const;

export type CawPactPreview = {
  intent: string;
  originalIntent: string;
  executionPlan: string;
  policies: unknown[];
  completionConditions: unknown[];
  draftedBy: "agent_llm" | "agent_deterministic";
  warnings: string[];
  limits: {
    singleLimitUsdcMinor: number;
    dailyLimitUsdcMinor: number;
    monthlyLimitUsdcMinor: number;
    validDays: number;
  };
};

export async function getDashboardSnapshot(userId = DEMO_USER_ID) {
  await refreshPendingTopupOrders({ userId });
  return getCreditRepository().snapshotForUser(userId);
}

export async function bindCoboAccount(input: { userId?: string; coboId?: string }) {
  const repository = getCreditRepository();
  const userId = input.userId ?? DEMO_USER_ID;
  const user = await repository.requireUser(userId);
  const coboId = normalizeCoboId(input.coboId);
  const existing = await repository.findUserByCoboId(coboId);
  if (existing && existing.id !== user.id) {
    throw new Error(`This Cobo ID is already bound to ${existing.email}.`);
  }

  const currentCoboId = user.coboId?.toLowerCase();
  const coboIdChanged = currentCoboId !== coboId;
  if (currentCoboId && currentCoboId !== coboId) {
    const [creditsAuthorization, veniceAuthorization] = await Promise.all([
      repository.getActiveAuthorization(userId, "credits_payment"),
      repository.getActiveAuthorization(userId, "venice_x402")
    ]);
    if (user.cawWalletId || user.cawWalletAddress || creditsAuthorization || veniceAuthorization) {
      throw new Error("Cobo ID cannot be changed after a CAW wallet or Pact has been bound.");
    }
  }

  const updated = await repository.updateUser({
    ...user,
    coboId,
    coboIdBoundAt: coboIdChanged ? repository.nowIso() : user.coboIdBoundAt ?? repository.nowIso()
  });

  return {
    user: updated,
    binding: {
      coboId: updated.coboId,
      coboIdBoundAt: updated.coboIdBoundAt,
      status: "bound"
    },
    snapshot: await repository.snapshotForUser(userId)
  };
}

export async function getCawIntegrationStatus(userId = DEMO_USER_ID) {
  const snapshot = await getDashboardSnapshot(userId);
  const runtime = await getUserCawRuntimeStatus(snapshot.user, snapshot.cawOnboardingSession);
  const activeAuthorization = snapshot.authorization?.status === "active";
  const missing = [...runtime.missing];
  const readinessMissing: string[] = [];
  const requiredUsdcMinor = creditsToUsdcMinor(snapshot.account.autoTopupCredits);
  const remainingUsdcMinor = snapshot.pactDetails?.remainingUsdcMinor ?? 0;
  const expiresAt = snapshot.authorization?.expiresAt;

  if (!snapshot.user.cawWalletAddress) {
    missing.push("connected CAW wallet address");
  }
  if (
    runtime.mode === "http" &&
    runtime.walletAddress &&
    snapshot.user.cawWalletAddress &&
    runtime.walletAddress.toLowerCase() !== snapshot.user.cawWalletAddress.toLowerCase()
  ) {
    missing.push("connected wallet does not match CAW runtime wallet");
  }
  if (!activeAuthorization) {
    missing.push("active Pact authorization");
  }
  if (runtime.mode === "http" && snapshot.authorization?.pactId.startsWith("mock_")) {
    missing.push("real CAW Pact authorization");
  }
  if (activeAuthorization && expiresAt && Date.parse(expiresAt) <= Date.now()) {
    readinessMissing.push("Pact authorization expired");
  }
  if (activeAuthorization && remainingUsdcMinor < requiredUsdcMinor) {
    readinessMissing.push("Pact remaining spend below next payment");
  }

  const onchainReadiness =
    runtime.mode === "http" &&
    runtime.walletAddress &&
    snapshot.user.cawWalletAddress &&
    process.env.PAYMENT_CONTRACT_ADDRESS
      ? await getOnchainSpendReadiness({
          walletAddress: snapshot.user.cawWalletAddress,
          paymentContractAddress: process.env.PAYMENT_CONTRACT_ADDRESS,
          requiredUsdcMinor
        })
      : undefined;

  if (onchainReadiness?.error) {
    readinessMissing.push("on-chain readiness check unavailable");
  }
  if (onchainReadiness && !onchainReadiness.error) {
    if ((onchainReadiness.allowanceUsdcMinor ?? 0) < requiredUsdcMinor) {
      readinessMissing.push("USDC allowance below next payment");
    }
    if ((onchainReadiness.walletUsdcMinor ?? 0) < requiredUsdcMinor) {
      readinessMissing.push("USDC balance below next payment");
    }
    if ((onchainReadiness.gasEthWei ?? 0n) <= 0n) {
      readinessMissing.push(`${getConfiguredChain().name} ETH gas balance missing`);
    }
  }

  const cawConfigured = missing.length === 0;
  const paymentMissing = [...missing, ...readinessMissing];

  return {
    runtime,
    app: {
      connectedWalletAddress: snapshot.user.cawWalletAddress,
      authorizationStatus: snapshot.authorization?.status ?? "missing",
      pactId: snapshot.authorization?.pactId,
      activeAuthorization,
      cawOnboardingStatus: snapshot.cawOnboardingSession?.status
    },
    spendReadiness: {
      requiredUsdcMinor,
      remainingUsdcMinor,
      pactExpiresAt: expiresAt,
      allowanceUsdcMinor: onchainReadiness?.allowanceUsdcMinor,
      walletUsdcMinor: onchainReadiness?.walletUsdcMinor,
      gasEth: onchainReadiness?.gasEth,
      error: onchainReadiness?.error
    },
    cawConfigured,
    readyForRealPayment: paymentMissing.length === 0,
    missing: paymentMissing,
    configurationMissing: missing,
    paymentMissing: readinessMissing
  };
}

async function getUserCawRuntimeStatus(
  user: User,
  onboarding?: CawWalletOnboardingSession
) {
  if (onboarding?.status === "wallet_active") {
    return getCawCliRuntimeStatus({
      userId: user.id,
      walletId: user.cawWalletId ?? onboarding.walletId
    });
  }

  const config = await resolveUserCawGatewayConfig(user.id, user);
  return getCawRuntimeStatus({
    ...config,
    useDefaultWallet: false
  });
}

export async function getCawWalletOnboarding(input: { userId?: string }) {
  const repository = getCreditRepository();
  const userId = input.userId ?? DEMO_USER_ID;
  await repository.requireUser(userId);
  return {
    onboarding: await repository.getCawOnboardingSession(userId),
    snapshot: await repository.snapshotForUser(userId)
  };
}

export async function advanceCawWalletOnboarding(input: {
  userId?: string;
  agentName?: string;
  apiUrl?: string;
  answers?: Record<string, unknown>;
}) {
  const repository = getCreditRepository();
  const userId = input.userId ?? DEMO_USER_ID;
  const user = await repository.requireUser(userId);
  const existing = await repository.getCawOnboardingSession(userId);
  const result = await runCawOnboard({
    userId,
    sessionId: existing?.sessionId,
    agentName: input.agentName?.trim() || existing?.agentName || defaultAgentName(user.email),
    apiUrl: input.apiUrl?.trim() || existing?.apiUrl || process.env.AGENT_WALLET_API_URL,
    answers: input.answers
  });
  const now = repository.nowIso();
  const partialSession: CawWalletOnboardingSession = {
    userId,
    sessionId: result.sessionId ?? existing?.sessionId,
    status: normalizeOnboardingStatus(result),
    phase: result.phase ?? existing?.phase,
    walletStatus: result.walletStatus ?? existing?.walletStatus,
    needsInput: result.needsInput,
    prompts: result.prompts,
    nextAction: result.nextAction,
    lastError: result.lastError,
    agentName: input.agentName?.trim() || existing?.agentName || defaultAgentName(user.email),
    apiUrl: result.apiUrl ?? input.apiUrl?.trim() ?? existing?.apiUrl ?? process.env.AGENT_WALLET_API_URL,
    walletId: result.walletId ?? existing?.walletId,
    walletName: result.walletName ?? existing?.walletName,
    agentId: result.agentId ?? existing?.agentId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };

  const completed = partialSession.status === "wallet_active";
  let connection:
    | {
        walletId?: string;
        walletAddress?: string;
        walletName?: string;
        agentId?: string;
      }
    | undefined;

  if (completed) {
    const profile = await readCawCliWalletProfile(userId);
    partialSession.walletId = profile.walletId ?? partialSession.walletId;
    partialSession.walletName = profile.walletName ?? partialSession.walletName;
    partialSession.agentId = profile.agentId ?? partialSession.agentId;
    partialSession.apiUrl = profile.apiUrl ?? partialSession.apiUrl;
    if (partialSession.walletId && profile.walletAddress) {
      await bindDiscoveredCawWallet({
        user,
        walletId: partialSession.walletId,
        walletAddress: profile.walletAddress
      });
    }
    connection = {
      walletId: partialSession.walletId,
      walletAddress: profile.walletAddress,
      walletName: partialSession.walletName,
      agentId: partialSession.agentId
    };
  }

  const onboarding = await repository.upsertCawOnboardingSession(partialSession);
  if (completed && partialSession.walletId && connection?.walletAddress && partialSession.agentId && partialSession.apiUrl) {
    await repository.upsertCawRuntimeCredential({
      userId,
      walletId: partialSession.walletId,
      walletAddress: connection.walletAddress,
      walletName: partialSession.walletName,
      agentId: partialSession.agentId,
      apiUrl: partialSession.apiUrl,
      apiKeyEncrypted: `caw-cli-profile:${partialSession.walletId}`,
      cawHomePath: getCawHomePathForUser(userId).replace(`${process.cwd()}/`, ""),
      lastVerifiedAt: now
    });
  }

  return {
    onboarding,
    connection,
    snapshot: await repository.snapshotForUser(userId)
  };
}

async function getOnchainSpendReadiness(input: {
  walletAddress: string;
  paymentContractAddress: string;
  requiredUsdcMinor: number;
}) {
  try {
    const chainConfig = getConfiguredChain();
    const viemChain = process.env.CHAIN_ENV === "base-mainnet" ? base : baseSepolia;
    const rpcUrl =
      process.env.BASE_RPC_URL ||
      (process.env.CHAIN_ENV === "base-mainnet" ? "https://mainnet.base.org" : "https://sepolia.base.org");
    const client = createPublicClient({
      chain: viemChain,
      transport: http(rpcUrl)
    });
    const erc20Abi = [
      {
        type: "function",
        name: "balanceOf",
        stateMutability: "view",
        inputs: [{ name: "account", type: "address" }],
        outputs: [{ type: "uint256" }]
      },
      {
        type: "function",
        name: "allowance",
        stateMutability: "view",
        inputs: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" }
        ],
        outputs: [{ type: "uint256" }]
      }
    ] as const;
    const walletAddress = getAddress(input.walletAddress);
    const paymentContractAddress = getAddress(input.paymentContractAddress);
    const usdcAddress = getAddress(chainConfig.usdcAddress);
    const [gasEthWei, walletUsdc, allowanceUsdc] = await Promise.all([
      client.getBalance({ address: walletAddress }),
      client.readContract({
        address: usdcAddress,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [walletAddress]
      }),
      client.readContract({
        address: usdcAddress,
        abi: erc20Abi,
        functionName: "allowance",
        args: [walletAddress, paymentContractAddress]
      })
    ]);

    return {
      gasEthWei,
      gasEth: formatUnits(gasEthWei, 18),
      walletUsdcMinor: Number(walletUsdc),
      allowanceUsdcMinor: Number(allowanceUsdc)
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "unknown on-chain readiness error"
    };
  }
}

export async function createPairingCode(input: { userId?: string }) {
  const repository = getCreditRepository();
  const userId = input.userId ?? DEMO_USER_ID;
  const user = await repository.requireUser(userId);
  const onboarding = await repository.getCawOnboardingSession(userId);
  const walletId = getUserCawWalletId(user);
  if (!walletId) {
    throw new Error("Bind a CAW Wallet UUID before generating a pairing code.");
  }
  const pairing =
    onboarding?.status === "wallet_active"
      ? await createCawCliPairingCode(userId)
      : await (await createUserCawGateway(userId, user)).createPairingCode({ userId, walletId });
  const session = await repository.createPairingSession(userId, {
    code: pairing.code,
    status: pairing.status,
    expiresAt: pairing.expiresAt,
    createdAt: repository.nowIso()
  });

  return {
    pairingSession: session,
    snapshot: await repository.snapshotForUser(userId)
  };
}

export async function refreshPairingStatus(input: { userId?: string }) {
  const repository = getCreditRepository();
  const userId = input.userId ?? DEMO_USER_ID;
  await repository.requireUser(userId);
  const existing = (await repository.snapshotForUser(userId)).pairingSession;
  if (!existing) {
    return {
      pairingSession: undefined,
      snapshot: await repository.snapshotForUser(userId)
    };
  }
  if (existing.status === "paired" || existing.status === "expired") {
    return {
      pairingSession: existing,
      snapshot: await repository.snapshotForUser(userId)
    };
  }
  if (Date.parse(existing.expiresAt) <= Date.now()) {
    const expired = await repository.createPairingSession(userId, {
      ...existing,
      status: "expired"
    });
    return {
      pairingSession: expired,
      snapshot: await repository.snapshotForUser(userId)
    };
  }
  const onboarding = await repository.getCawOnboardingSession(userId);
  if (onboarding?.status !== "wallet_active") {
    return {
      pairingSession: existing,
      snapshot: await repository.snapshotForUser(userId)
    };
  }
  const upstream = await getCawCliPairingStatus(userId);
  const nextStatus =
    upstream.tokenStatus === "paired" || upstream.tokenStatus === "completed"
      ? "paired"
      : upstream.tokenStatus === "expired"
        ? "expired"
        : "generated";
  const session = await repository.createPairingSession(userId, {
    ...existing,
    code: upstream.token ?? existing.code,
    status: nextStatus
  });
  return {
    pairingSession: session,
    snapshot: await repository.snapshotForUser(userId)
  };
}

export async function recommendGuardrails(input: {
  userId?: string;
  agentCount?: number;
  dailySpendUsdc?: number;
  riskProfile?: "conservative" | "balanced" | "growth";
}) {
  const repository = getCreditRepository();
  const userId = input.userId ?? DEMO_USER_ID;
  const snapshot = await repository.snapshotForUser(userId);
  const riskMultiplier =
    input.riskProfile === "growth" ? 1.5 : input.riskProfile === "conservative" ? 0.7 : 1;
  const agentCount = Math.max(1, input.agentCount ?? 2);
  const dailySpendUsdc = Math.max(1, input.dailySpendUsdc ?? 10);
  const reviewThresholdUsdcMinor = Math.round(
    Math.min(10, Math.max(1, dailySpendUsdc / agentCount / 2) * riskMultiplier) * 1_000_000
  );

  return {
    recommendation: {
      ...snapshot.guardrails,
      reviewThresholdUsdcMinor,
      singleLimitUsdcMinor: Math.max(
        reviewThresholdUsdcMinor,
        Math.round(dailySpendUsdc * 0.5 * riskMultiplier * 1_000_000)
      ),
      dailyLimitUsdcMinor: Math.round(dailySpendUsdc * riskMultiplier * 1_000_000),
      allowedChains: [getConfiguredCawChainId()],
      generatedBy: "ai_direct" as const,
      updatedAt: repository.nowIso()
    },
    note:
      "Demo recommendation only. Final Guardrails must be confirmed in Cobo Agentic Wallet App.",
    snapshot
  };
}

export async function connectCawWallet(input: {
  userId?: string;
  cawWalletId?: string;
  walletAddress?: string;
}) {
  const repository = getCreditRepository();
  const userId = input.userId ?? DEMO_USER_ID;
  const user = await repository.requireUser(userId);
  const walletId = input.cawWalletId?.trim() || getUserCawWalletId(user);
  if (!walletId) {
    throw new Error("CAW Wallet UUID is required.");
  }
  const existingWalletUser = await repository.findUserByCawWalletId(walletId);
  if (existingWalletUser && existingWalletUser.id !== user.id) {
    throw new Error(`This CAW wallet profile is already bound to ${existingWalletUser.email}.`);
  }
  // Try CLI first (works without .env credentials — uses the local caw profile).
  // Fall back to gateway only if CLI can't resolve the wallet.
  let connection: { connectionId: string; walletId?: string; walletAddress: string };
  const cliInfo = await getCawWalletInfoFromList(userId, walletId);
  if (cliInfo?.walletAddress) {
    connection = {
      connectionId: `cli_${walletId}`,
      walletId,
      walletAddress: cliInfo.walletAddress
    };
  } else {
    const gateway = await createUserCawGateway(userId, user);
    connection = await gateway.connectWallet({
      userId,
      walletId,
      walletAddress: input.walletAddress
    });
  }
  if (!connection.walletAddress) {
    throw new Error("CAW wallet address was not found for this Wallet UUID.");
  }
  const existing = await repository.findUserByCawWalletAddress(connection.walletAddress);
  if (existing && existing.id !== user.id) {
    throw new Error(`This CAW wallet is already bound to ${existing.email}.`);
  }
  const activeAuthorization = await repository.getActiveAuthorization(userId);
  if (
    activeAuthorization &&
    user.cawWalletAddress &&
    user.cawWalletAddress.toLowerCase() !== connection.walletAddress.toLowerCase()
  ) {
    throw new Error("This account already has a Pact for another CAW wallet. Create a new user or revoke the old Pact first.");
  }

  await repository.updateUser({
    ...user,
    cawWalletId: connection.walletId ?? walletId,
    cawWalletAddress: connection.walletAddress
  });

  // Auto-create an onboarding session with wallet_active status so that
  // subsequent CLI operations (pairing, pact) use the CLI path instead of
  // the gateway (which requires .env credentials).
  const existingOnboarding = await repository.getCawOnboardingSession(userId);
  if (!existingOnboarding || existingOnboarding.status !== "wallet_active") {
    const cliInfo = await getCawWalletInfoFromList(userId, walletId);
    await repository.upsertCawOnboardingSession({
      userId,
      status: "wallet_active",
      needsInput: false,
      prompts: [],
      walletId: connection.walletId ?? walletId,
      walletName: cliInfo?.walletName,
      agentId: cliInfo?.agentId,
      apiUrl: cliInfo?.apiUrl,
      createdAt: existingOnboarding?.createdAt ?? repository.nowIso(),
      updatedAt: repository.nowIso()
    });
    if (cliInfo?.agentId && cliInfo.apiUrl) {
      await repository.upsertCawRuntimeCredential({
        userId,
        walletId: connection.walletId ?? walletId,
        walletAddress: connection.walletAddress,
        walletName: cliInfo.walletName,
        agentId: cliInfo.agentId,
        apiUrl: cliInfo.apiUrl,
        apiKeyEncrypted: `caw-cli-profile:${connection.walletId ?? walletId}`,
        cawHomePath: getCawHomePathForUser(userId).replace(`${process.cwd()}/`, ""),
        lastVerifiedAt: repository.nowIso()
      });
    }
  }

  return {
    connection,
    snapshot: await repository.snapshotForUser(userId)
  };
}

export async function createCawAuthorization(input: {
  userId?: string;
  intent?: string;
  singleLimitUsdcMinor?: number;
  dailyLimitUsdcMinor?: number;
  monthlyLimitUsdcMinor?: number;
  validDays?: number;
}) {
  const repository = getCreditRepository();
  const userId = input.userId ?? DEMO_USER_ID;
  const user = await repository.requireUser(userId);
  const onboarding = await repository.getCawOnboardingSession(userId);
  const wallet = requireBoundCawWallet(user);
  const createdAt = repository.nowIso();
  const { preview } = await previewCawAuthorization(input);
  const expiresAt = new Date(
    Date.now() + preview.limits.validDays * 24 * 60 * 60 * 1000
  ).toISOString();
  const pactResult =
    onboarding?.status === "wallet_active"
      ? await submitCawCliPact({
          userId,
          name: "Agent credits auto top-up",
          intent: preview.intent,
          originalIntent: preview.originalIntent,
          executionPlan: preview.executionPlan,
          policies: preview.policies,
          completionConditions: preview.completionConditions
        })
      : await (await createUserCawGateway(userId, user)).createPact({
          userId,
          walletId: wallet.walletId,
          walletAddress: wallet.walletAddress,
          contractAddress: process.env.PAYMENT_CONTRACT_ADDRESS,
          usdcAddress: getConfiguredChain().usdcAddress,
          singleLimitUsdcMinor: preview.limits.singleLimitUsdcMinor,
          dailyLimitUsdcMinor: preview.limits.dailyLimitUsdcMinor,
          monthlyLimitUsdcMinor: preview.limits.monthlyLimitUsdcMinor,
          expiresAt,
          pactIntent: preview.intent,
          originalIntent: preview.originalIntent,
          executionPlan: preview.executionPlan,
          policies: preview.policies,
          completionConditions: preview.completionConditions
        });
  const pact = {
    pactId: pactResult.pactId,
    status: pactResult.status,
    approvalUrl: "approvalUrl" in pactResult ? pactResult.approvalUrl : undefined,
    pactApiKey: "pactApiKey" in pactResult ? pactResult.pactApiKey : undefined
  };

  const authorization: CawAuthorization = {
    id: repository.createId("auth"),
    userId,
    purpose: "credits_payment",
    walletAddress: wallet.walletAddress,
    pactId: pact.pactId,
    pactApiKey: pact.pactApiKey,
    status: pact.status,
    singleLimitUsdcMinor: preview.limits.singleLimitUsdcMinor,
    dailyLimitUsdcMinor: preview.limits.dailyLimitUsdcMinor,
    monthlyLimitUsdcMinor: preview.limits.monthlyLimitUsdcMinor,
    spentTodayUsdcMinor: 0,
    spentMonthUsdcMinor: 0,
    dailyWindowStart: createdAt,
    monthlyWindowStart: createdAt,
    expiresAt,
    createdAt
  };

  await repository.createAuthorization(authorization);
  await repository.updateUser({
    ...user,
    cawWalletId: wallet.walletId,
    cawWalletAddress: wallet.walletAddress
  });

  return {
    authorization,
    approvalUrl: pact.approvalUrl,
    preview,
    snapshot: await repository.snapshotForUser(userId)
  };
}

export async function previewCawAuthorization(input: {
  userId?: string;
  intent?: string;
  singleLimitUsdcMinor?: number;
  dailyLimitUsdcMinor?: number;
  monthlyLimitUsdcMinor?: number;
  validDays?: number;
}): Promise<{ preview: CawPactPreview }> {
  const repository = getCreditRepository();
  const userId = input.userId ?? DEMO_USER_ID;
  const user = await repository.requireUser(userId);
  const wallet = requireBoundCawWallet(user);
  const chain = getConfiguredChain();
  const coboChainId = getConfiguredCawChainId();
  const contractAddress = process.env.PAYMENT_CONTRACT_ADDRESS;

  if (!contractAddress) {
    throw new Error("PAYMENT_CONTRACT_ADDRESS is required to preview a real CAW Pact.");
  }

  const limits = {
    singleLimitUsdcMinor: input.singleLimitUsdcMinor ?? DEFAULT_SPEND_POLICY.singleLimitUsdcMinor,
    dailyLimitUsdcMinor: input.dailyLimitUsdcMinor ?? DEFAULT_SPEND_POLICY.dailyLimitUsdcMinor,
    monthlyLimitUsdcMinor:
      input.monthlyLimitUsdcMinor ?? DEFAULT_SPEND_POLICY.monthlyLimitUsdcMinor,
    validDays: input.validDays ?? DEFAULT_SPEND_POLICY.validDays
  };
  const userIntent =
    input.intent?.trim() ||
    `Allow this agent to automatically top up my internal credits with ${chain.name} USDC when the balance is low.`;
  const draft = await draftCawPactFromIntent({
    intent: userIntent,
    context: {
      walletAddress: wallet.walletAddress,
      chainName: chain.name,
      cawChainId: coboChainId,
      usdcAddress: chain.usdcAddress,
      paymentContractAddress: contractAddress,
      limits
    }
  });

  return {
    preview: {
      intent: draft.intent,
      originalIntent: draft.originalIntent,
      executionPlan: draft.executionPlan,
      policies: draft.policies,
      completionConditions: draft.completionConditions,
      draftedBy: draft.draftedBy,
      warnings: draft.warnings,
      limits: draft.limits
    }
  };
}

export async function previewVeniceX402Authorization(input: {
  userId?: string;
  amountUsdcMinor?: number;
  dailyLimitUsdcMinor?: number;
  monthlyLimitUsdcMinor?: number;
  validDays?: number;
}): Promise<{
  preview: CawPactPreview;
  requirements: Awaited<ReturnType<typeof discoverVeniceX402Requirements>>;
  selected: VeniceX402Accept;
  authorization?: CawAuthorization;
  snapshot: Awaited<ReturnType<typeof getDashboardSnapshot>>;
}> {
  const repository = getCreditRepository();
  const userId = input.userId ?? DEMO_USER_ID;
  const user = await repository.requireUser(userId);
  requireBoundCawWallet(user);
  await requireVeniceCliWallet(userId);
  const requirements = await discoverVeniceX402Requirements();
  const selected = pickVeniceBaseUsdcAccept(requirements);
  const preview = buildVeniceX402PactPreview({
    accept: selected,
    limits: normalizeVenicePactLimits(input)
  });

  return {
    preview,
    requirements,
    selected,
    authorization: await repository.getActiveAuthorization(userId, "venice_x402"),
    snapshot: await repository.snapshotForUser(userId)
  };
}

export async function createVeniceX402Authorization(input: {
  userId?: string;
  amountUsdcMinor?: number;
  dailyLimitUsdcMinor?: number;
  monthlyLimitUsdcMinor?: number;
  validDays?: number;
}) {
  const repository = getCreditRepository();
  const userId = input.userId ?? DEMO_USER_ID;
  const user = await repository.requireUser(userId);
  const wallet = requireBoundCawWallet(user);
  await requireVeniceCliWallet(userId);
  const { preview, requirements, selected } = await previewVeniceX402Authorization({
    ...input,
    userId
  });
  const createdAt = repository.nowIso();
  const expiresAt = new Date(
    Date.now() + preview.limits.validDays * 24 * 60 * 60 * 1000
  ).toISOString();
  const pactResult = await submitCawCliPact({
    userId,
    name: "Venice x402 USDC top-up",
    intent: preview.intent,
    originalIntent: preview.originalIntent,
    executionPlan: preview.executionPlan,
    policies: preview.policies,
    completionConditions: preview.completionConditions
  });
  const authorization: CawAuthorization = {
    id: repository.createId("auth"),
    userId,
    purpose: "venice_x402",
    walletAddress: wallet.walletAddress,
    pactId: pactResult.pactId,
    status: pactResult.status,
    singleLimitUsdcMinor: preview.limits.singleLimitUsdcMinor,
    dailyLimitUsdcMinor: preview.limits.dailyLimitUsdcMinor,
    monthlyLimitUsdcMinor: preview.limits.monthlyLimitUsdcMinor,
    spentTodayUsdcMinor: 0,
    spentMonthUsdcMinor: 0,
    dailyWindowStart: createdAt,
    monthlyWindowStart: createdAt,
    expiresAt,
    createdAt
  };

  await repository.createAuthorization(authorization);

  return {
    authorization,
    preview,
    requirements,
    selected,
    snapshot: await repository.snapshotForUser(userId)
  };
}

export async function refreshVeniceX402Authorization(input: { userId?: string }) {
  const repository = getCreditRepository();
  const userId = input.userId ?? DEMO_USER_ID;
  await requireVeniceCliWallet(userId);
  const authorization = await repository.getActiveAuthorization(userId, "venice_x402");
  if (!authorization) {
    throw new Error("No Venice x402 CAW authorization to refresh.");
  }

  const pact = await showCawCliPact({ userId, pactId: authorization.pactId });
  const updated = await repository.updateAuthorization({
    ...authorization,
    status: pact.status
  });

  return {
    authorization: updated,
    snapshot: await repository.snapshotForUser(userId)
  };
}

export async function refreshCawAuthorization(input: { userId?: string }) {
  const repository = getCreditRepository();
  const userId = input.userId ?? DEMO_USER_ID;
  const authorization = await repository.getActiveAuthorization(userId);
  if (!authorization) {
    throw new Error("No CAW authorization to refresh.");
  }

  const onboarding = await repository.getCawOnboardingSession(userId);
  const pact =
    onboarding?.status === "wallet_active"
      ? await showCawCliPact({ userId, pactId: authorization.pactId })
      : await (await createUserCawGateway(userId)).getPact({ pactId: authorization.pactId });
  const updated = await repository.updateAuthorization({
    ...authorization,
    status: pact.status,
    pactApiKey: "pactApiKey" in pact ? pact.pactApiKey ?? authorization.pactApiKey : authorization.pactApiKey
  });

  return {
    authorization: updated,
    snapshot: await repository.snapshotForUser(userId)
  };
}

export async function approveUsdcForCreditsPayment(input: {
  userId?: string;
  amountUsdcMinor?: number;
}) {
  const repository = getCreditRepository();
  const userId = input.userId ?? DEMO_USER_ID;
  const user = await repository.requireUser(userId);
  const account = await repository.requireCreditAccount(userId);
  const authorization = await repository.getActiveAuthorization(userId);
  const wallet = requireBoundCawWallet(user);
  const amountUsdcMinor = input.amountUsdcMinor ?? creditsToUsdcMinor(account.autoTopupCredits);

  if (!authorization || authorization.status !== "active") {
    throw new Error("Approve an active CAW Pact in Cobo App before approving USDC.");
  }
  if (Date.parse(authorization.expiresAt) <= Date.now()) {
    authorization.status = "expired";
    await repository.updateAuthorization(authorization);
    throw new Error("The active CAW Pact is expired. Create and approve a new Pact first.");
  }
  if (authorization.monthlyLimitUsdcMinor - authorization.spentMonthUsdcMinor < amountUsdcMinor) {
    throw new Error("The active CAW Pact has no remaining spend for this approval. Create and approve a new Pact first.");
  }

  const runtime = await getUserRuntimeStatusForBoundWallet(userId, user);
  if (runtime.mode !== "http") {
    throw new Error("USDC approval requires real CAW mode.");
  }
  if (authorization.pactId.startsWith("mock_")) {
    throw new Error("Mock Pact cannot approve real USDC.");
  }

  const readiness = await getOnchainSpendReadiness({
    walletAddress: wallet.walletAddress,
    paymentContractAddress: requiredPaymentContractAddress(),
    requiredUsdcMinor: amountUsdcMinor
  });
  if (readiness.error) {
    throw new Error(`Unable to check on-chain USDC allowance: ${readiness.error}`);
  }
  if ((readiness.walletUsdcMinor ?? 0) < amountUsdcMinor) {
    throw new Error("CAW wallet USDC balance is below the requested approval amount.");
  }
  if ((readiness.gasEthWei ?? 0n) <= 0n) {
    throw new Error(`CAW wallet needs ${getConfiguredChain().name} ETH for gas before approving USDC.`);
  }
  if ((readiness.allowanceUsdcMinor ?? 0) >= amountUsdcMinor) {
    return {
      status: "already_approved" as const,
      allowanceUsdcMinor: readiness.allowanceUsdcMinor,
      snapshot: await repository.snapshotForUser(userId)
    };
  }

  const gateway = await createUserCawGateway(userId, user);
  const result = await gateway.executeUsdcApproval({
    userId,
    walletId: wallet.walletId,
    walletAddress: wallet.walletAddress,
    pactId: authorization.pactId,
    pactApiKey: authorization.pactApiKey,
    spenderAddress: requiredPaymentContractAddress(),
    usdcAddress: getConfiguredChain().usdcAddress,
    amountUsdcMinor
  });

  return {
    status: result.status,
    txHash: result.txHash,
    amountUsdcMinor,
    snapshot: await repository.snapshotForUser(userId)
  };
}

export async function requestTestTokens(input: { userId?: string; tokenId?: string }) {
  const repository = getCreditRepository();
  const userId = input.userId ?? DEMO_USER_ID;
  const user = await repository.requireUser(userId);
  const wallet = requireBoundCawWallet(user);
  const gateway = await createUserCawGateway(userId, user);
  const faucet = await gateway.requestFaucet({
    walletAddress: wallet.walletAddress,
    tokenId: input.tokenId
  });

  return {
    faucet,
    snapshot: await repository.snapshotForUser(userId)
  };
}

export async function runAgentTask(input: {
  userId?: string;
  agentId?: string;
  taskName?: string;
  prompt?: string;
}) {
  const repository = getCreditRepository();
  const userId = input.userId ?? DEMO_USER_ID;
  const taskName = input.taskName?.trim() || "research-agent";
  const prompt = input.prompt?.trim() || "Summarize wallet funding state and continue.";
  const agent = input.agentId
    ? (await repository.snapshotForUser(userId)).agents.find((candidate) => candidate.id === input.agentId)
    : await repository.getOrCreateAgent({ userId, name: taskName });
  if (!agent || agent.userId !== userId) {
    throw new Error("Unknown agent for this user.");
  }
  let agentRun = await repository.createAgentRun({
    userId,
    agentId: agent.id,
    taskName,
    prompt,
    status: "running"
  });
  const user = await repository.requireUser(userId);
  const veniceAuthorization = await repository.getActiveAuthorization(userId, "venice_x402");
  let veniceTopup: Awaited<ReturnType<typeof runVeniceX402Topup>> | undefined;
  if (agent.veniceAutoTopup && user.cawWalletAddress && veniceAuthorization?.status === "active") {
    try {
      const balance = await refreshVeniceBalance({ walletAddress: user.cawWalletAddress });
      if (!balance.canConsume) {
        veniceTopup = await runVeniceX402Topup({
          userId,
          agentId: agent.id,
          agentRunId: agentRun.id,
          walletAddress: user.cawWalletAddress,
          pactId: veniceAuthorization.pactId,
          usdAmount: agent.veniceTopupUsdMinor / 1_000_000
        });
        if (!veniceTopup.balance?.canConsume) {
          agentRun = await repository.updateAgentRun({
            ...agentRun,
            status: "waiting_for_venice_balance",
            resumeAfterOrderId: veniceTopup.order?.id,
            lastError: veniceTopup.order?.failureReason
          });
          await repository.updateAgent({ ...agent, status: "paused" });
          return {
            ok: false,
            agent,
            agentRun,
            veniceTopup,
            snapshot: await repository.snapshotForUser(userId)
          };
        }
      }
    } catch (error) {
      agentRun = await repository.updateAgentRun({
        ...agentRun,
        status: "waiting_for_venice_balance",
        lastError: error instanceof Error ? error.message : "Venice balance check failed."
      });
      await repository.updateAgent({ ...agent, status: "paused" });
      return {
        ok: false,
        agent,
        agentRun,
        veniceTopup,
        snapshot: await repository.snapshotForUser(userId)
      };
    }
  }
  let account = await repository.requireCreditAccount(userId);
  const estimatedCredits = estimateAgentCredits(prompt);
  let topup: Awaited<ReturnType<typeof executeAutoTopup>> | undefined;

  if (account.balanceCredits < estimatedCredits) {
    topup = await executeAutoTopup({ userId, reason: "insufficient_balance" });
    account = await repository.requireCreditAccount(userId);
  }

  if (account.balanceCredits < estimatedCredits) {
    const usageEvent = await repository.createUsageEvent({
      userId,
      taskName,
      prompt,
      estimatedCredits,
      creditsCharged: 0,
      status: "failed_insufficient_balance"
    });
    agentRun = await repository.updateAgentRun({
      ...agentRun,
      status: "failed",
      lastError: "insufficient internal credits",
      completedAt: repository.nowIso()
    });

    return {
      ok: false,
      agent,
      agentRun,
      usageEvent,
      topup,
      veniceTopup,
      snapshot: await repository.snapshotForUser(userId)
    };
  }

  account.balanceCredits -= estimatedCredits;
  account.updatedAt = repository.nowIso();
  await repository.updateCreditAccount(account);
  const usageEvent = await repository.createUsageEvent({
    userId,
    taskName,
    prompt,
    estimatedCredits,
    creditsCharged: estimatedCredits,
    status: "completed"
  });
  agentRun = await repository.updateAgentRun({
    ...agentRun,
    status: "completed",
    completedAt: repository.nowIso()
  });
  if (agent.status === "paused") {
    await repository.updateAgent({ ...agent, status: "active" });
  }

  await repository.appendLedgerEntry({
    userId,
    type: "agent_usage",
    creditsDelta: -estimatedCredits,
    balanceAfterCredits: account.balanceCredits,
    usageEventId: usageEvent.id
  });

  if (account.balanceCredits < account.lowBalanceThresholdCredits) {
    topup = await executeAutoTopup({ userId, reason: "low_balance" });
  }

  return {
    ok: true,
    agent,
    agentRun,
    usageEvent,
    topup,
    veniceTopup,
    snapshot: await repository.snapshotForUser(userId)
  };
}

export async function executeAutoTopup(input: {
  userId?: string;
  reason?: AutoTopupReason;
}) {
  return executeCreditsTopup({
    userId: input.userId,
    reason: input.reason,
    skipIfBalanceAboveThreshold: input.reason === undefined || input.reason === "low_balance"
  });
}

export function getX402ResourcePriceUsdcMinor() {
  const configured = Number(
    process.env.X402_RESOURCE_PRICE_USDC_MINOR ?? DEFAULT_X402_RESOURCE_PRICE_USDC_MINOR
  );
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_X402_RESOURCE_PRICE_USDC_MINOR;
  }
  return Math.floor(configured);
}

export async function createX402ResourcePayment(input: {
  userId?: string;
}) {
  const amountUsdcMinor = getX402ResourcePriceUsdcMinor();
  const credits = Math.max(1, usdcMinorToCredits(amountUsdcMinor));
  const topup = await executeCreditsTopup({
    userId: input.userId,
    reason: "x402_resource",
    amountUsdcMinor,
    credits,
    skipIfBalanceAboveThreshold: false
  });
  const order = "order" in topup ? topup.order : undefined;

  return {
    ...topup,
    x402: {
      amountUsdcMinor,
      credits,
      paymentProof: order?.orderId,
      paymentHeader: "x-payment-proof",
      resourcePath: "/api/x402/resource"
    }
  };
}

export async function verifyX402ResourcePayment(input: {
  userId?: string;
  proof: string;
}) {
  const repository = getCreditRepository();
  const userId = input.userId ?? DEMO_USER_ID;
  const proof = input.proof.trim();
  if (!proof) {
    return { ok: false as const, reason: "missing_payment_proof" };
  }

  let order =
    (await repository.findTopupOrderByOrderId({ orderId: proof })) ??
    (isTransactionHash(proof)
      ? await repository.findTopupOrderByTxHash({ userId, txHash: proof })
      : undefined);

  if (!order || order.userId !== userId) {
    return { ok: false as const, reason: "payment_not_found" };
  }

  if (order.status !== "credited") {
    await refreshPendingTopupOrders({ userId });
    order =
      (await repository.findTopupOrderByOrderId({ orderId: proof })) ??
      (isTransactionHash(proof)
        ? await repository.findTopupOrderByTxHash({ userId, txHash: proof })
        : undefined);
  }

  if (!order || order.userId !== userId) {
    return { ok: false as const, reason: "payment_not_found" };
  }

  const requiredAmountUsdcMinor = getX402ResourcePriceUsdcMinor();
  if (order.amountUsdcMinor < requiredAmountUsdcMinor) {
    return {
      ok: false as const,
      reason: "payment_amount_too_low",
      order,
      requiredAmountUsdcMinor
    };
  }

  if (order.status === "credited") {
    return { ok: true as const, order };
  }

  if (order.txHash && isTransactionHash(order.txHash)) {
    const receipt = await verifyCreditsPaymentReceipt(order);
    if (!receipt.ok) {
      return {
        ok: false as const,
        reason: receipt.reason,
        order
      };
    }

    const settlement = await settleCreditsPurchase({
      orderId: order.orderId,
      onchainOrderId: order.onchainOrderId,
      amountUsdcMinor: order.amountUsdcMinor,
      txHash: order.txHash,
      eventId: `x402:${order.txHash}:${order.orderId}`
    });

    if ("order" in settlement && settlement.order?.status === "credited") {
      return { ok: true as const, order: settlement.order };
    }

    return {
      ok: false as const,
      reason: settlement.status,
      order
    };
  }

  return {
    ok: false as const,
    reason: `payment_${order.status}`,
    order
  };
}

export async function refreshPendingTopupOrders(input: { userId?: string }) {
  const repository = getCreditRepository();
  const userId = input.userId ?? DEMO_USER_ID;
  const user = await repository.requireUser(userId).catch(() => undefined);
  if (!user) {
    return {
      status: "skipped" as const,
      reason: "missing_user",
      refreshed: 0,
      settled: 0,
      failed: 0
    };
  }
  const walletId = getUserCawWalletId(user);
  const pendingOrders = await repository.listPendingTopupOrders(userId);

  if (pendingOrders.length === 0) {
    return {
      status: "skipped" as const,
      reason: "no_pending_orders",
      refreshed: 0,
      settled: 0,
      failed: 0
    };
  }

  if (!walletId) {
    return {
      status: "skipped" as const,
      reason: "missing_caw_wallet_id",
      refreshed: 0,
      settled: 0,
      failed: 0
    };
  }

  let gateway: CawGateway;
  try {
    gateway = await createUserCawGateway(userId, user);
  } catch (error) {
    return {
      status: "skipped" as const,
      reason: error instanceof Error ? error.message : "caw_gateway_unavailable",
      refreshed: 0,
      settled: 0,
      failed: 0
    };
  }
  const results = [];

  for (const order of pendingOrders) {
    results.push(
      await refreshSingleTopupOrder({
        order,
        walletId,
        gateway
      }).catch((error: unknown) => ({
        status: "refresh_error" as const,
        orderId: order.orderId,
        reason: error instanceof Error ? error.message : "unknown_refresh_error"
      }))
    );
  }

  return {
    status: "refreshed" as const,
    refreshed: results.filter((result) => result.status !== "missing_caw_record").length,
    settled: results.filter((result) => result.status === "credited").length,
    failed: results.filter((result) => result.status === "failed").length,
    results
  };
}

export async function executeCreditsTopup(input: {
  userId?: string;
  reason?: AutoTopupReason;
  amountUsdcMinor?: number;
  credits?: number;
  skipIfBalanceAboveThreshold?: boolean;
}) {
  const repository = getCreditRepository();
  const userId = input.userId ?? DEMO_USER_ID;
  const reason = input.reason ?? "low_balance";
  const user = await repository.requireUser(userId);
  await refreshPendingTopupOrders({ userId });
  const account = await repository.requireCreditAccount(userId);

  if (input.skipIfBalanceAboveThreshold && account.balanceCredits >= account.lowBalanceThresholdCredits) {
    return {
      status: "skipped" as const,
      reason: "balance_above_threshold",
      snapshot: await repository.snapshotForUser(userId)
    };
  }

  const existingPending = await repository.findPendingTopupOrder(userId);

  if (existingPending) {
    if (isStalePolicyPendingOrder(existingPending)) {
      existingPending.status = "failed";
      existingPending.failureReason = "stale_pending_policy_order";
      existingPending.updatedAt = repository.nowIso();
      await repository.updateTopupOrder(existingPending);
    } else {
      return {
        status: "pending" as const,
        order: existingPending,
        snapshot: await repository.snapshotForUser(userId)
      };
    }
  }

  const freshPending = await repository.findPendingTopupOrder(userId);

  if (freshPending) {
    return {
      status: "pending" as const,
      order: freshPending,
      snapshot: await repository.snapshotForUser(userId)
    };
  }

  const credits = input.credits ?? account.autoTopupCredits;
  const amountUsdcMinor = input.amountUsdcMinor ?? creditsToUsdcMinor(credits);
  const policy = await checkAuthorizationPolicy(userId, amountUsdcMinor);

  if (!policy.ok) {
    const failedOrder = await repository.createTopupOrder({
      userId,
      walletAddress: user.cawWalletAddress ?? "unbound",
      amountUsdcMinor,
      credits,
      reason,
      status: "failed",
      failureReason: policy.reason
    });

    return {
      status: "blocked" as const,
      reason: policy.reason,
      order: failedOrder,
      snapshot: await repository.snapshotForUser(userId)
    };
  }
  const wallet = requireBoundCawWallet(user);

  const preflight = await checkRealPaymentPreflight({
    userId,
    walletId: wallet.walletId,
    walletAddress: policy.authorization.walletAddress,
    pactId: policy.authorization.pactId,
    amountUsdcMinor
  });

  if (!preflight.ok) {
    return {
      status: "blocked" as const,
      reason: preflight.reason,
      snapshot: await repository.snapshotForUser(userId)
    };
  }

  const order = await repository.createTopupOrder({
    userId,
    walletAddress: policy.authorization.walletAddress,
    amountUsdcMinor,
    credits,
    reason,
    status: "pending_policy"
  });

  const gateway = await createUserCawGateway(userId, user);
  const chain = getConfiguredChain();
  const cawResult = await gateway.executeCreditsPurchase({
    userId,
    walletId: wallet.walletId,
    walletAddress: policy.authorization.walletAddress,
    pactId: policy.authorization.pactId,
    pactApiKey: policy.authorization.pactApiKey,
    paymentContractAddress: process.env.PAYMENT_CONTRACT_ADDRESS,
    usdcAddress: chain.usdcAddress,
    orderId: order.orderId,
    onchainOrderId: order.onchainOrderId,
    amountUsdcMinor,
    credits
  }).catch(async (error: unknown) => {
    order.status = "failed";
    order.failureReason = error instanceof Error ? error.message : "caw_execution_failed";
    order.updatedAt = repository.nowIso();
    await repository.updateTopupOrder(order);
    throw error;
  });

  await recordAuthorizationSpend(policy.authorization, amountUsdcMinor);
  order.status = cawResult.status === "confirmed" ? "chain_pending" : "caw_submitted";
  order.txHash = cawResult.txHash;
  order.updatedAt = repository.nowIso();
  await repository.updateTopupOrder(order);
  let returnedOrder = order;

  if (cawResult.mockConfirmed) {
    const settlement = await settleCreditsPurchase({
      orderId: order.orderId,
      onchainOrderId: order.onchainOrderId,
      amountUsdcMinor: order.amountUsdcMinor,
      txHash: order.txHash,
      eventId: `mock_evt_${order.orderId}`
    });
    if ("order" in settlement && settlement.order) {
      returnedOrder = settlement.order;
    }
  }

  return {
    status: "submitted" as const,
    order: returnedOrder,
    snapshot: await repository.snapshotForUser(userId)
  };
}

export async function settleCreditsPurchase(input: {
  orderId?: string;
  onchainOrderId?: string;
  amountUsdcMinor: number;
  txHash?: string;
  eventId?: string;
}) {
  const repository = getCreditRepository();
  const eventId =
    input.eventId ??
    `${input.txHash ?? "no_tx"}:${input.orderId ?? input.onchainOrderId ?? "no_order"}`;

  if (await repository.hasChainEvent(eventId)) {
    return {
      status: "duplicate" as const,
      snapshot: await repository.snapshotForUser(DEMO_USER_ID)
    };
  }

  const marked = await repository.markChainEventSeen({
    eventId,
    txHash: input.txHash,
    orderId: input.orderId ?? input.onchainOrderId
  });
  if (!marked) {
    return {
      status: "duplicate" as const,
      snapshot: await repository.snapshotForUser(DEMO_USER_ID)
    };
  }
  const order = await repository.findTopupOrderByOrderId({
    orderId: input.orderId,
    onchainOrderId: input.onchainOrderId
  });

  if (!order) {
    throw new Error("No matching top-up order for chain event.");
  }

  if (order.status === "credited") {
    return {
      status: "already_credited" as const,
      order,
      snapshot: await repository.snapshotForUser(order.userId)
    };
  }

  if (order.amountUsdcMinor !== input.amountUsdcMinor) {
    order.status = "failed";
    order.failureReason = "chain_amount_mismatch";
    order.updatedAt = repository.nowIso();
    await repository.updateTopupOrder(order);
    return {
      status: "failed" as const,
      order,
      snapshot: await repository.snapshotForUser(order.userId)
    };
  }

  const account = await repository.requireCreditAccount(order.userId);
  account.balanceCredits += order.credits;
  account.updatedAt = repository.nowIso();
  await repository.updateCreditAccount(account);
  order.status = "credited";
  order.txHash = input.txHash ?? order.txHash;
  order.creditedAt = repository.nowIso();
  order.updatedAt = order.creditedAt;
  await repository.updateTopupOrder(order);

  await repository.appendLedgerEntry({
    userId: order.userId,
    type: "auto_topup",
    creditsDelta: order.credits,
    balanceAfterCredits: account.balanceCredits,
    orderId: order.orderId,
    usdcMinor: order.amountUsdcMinor,
    txHash: order.txHash
  });

  return {
    status: "credited" as const,
    order,
    snapshot: await repository.snapshotForUser(order.userId)
  };
}

export async function listCawTransactions(input: {
  userId?: string;
  limit?: number;
}) {
  const repository = getCreditRepository();
  const userId = input.userId ?? DEMO_USER_ID;
  const user = await repository.requireUser(userId);
  const wallet = requireBoundCawWallet(user);
  const gateway = await createUserCawGateway(userId, user);
  return gateway.listTransactions({
    walletId: wallet.walletId,
    limit: input.limit
  });
}

async function refreshSingleTopupOrder(input: {
  order: TopupOrder;
  walletId: string;
  gateway: CawGateway;
}) {
  const repository = getCreditRepository();
  const order = input.order;

  if (isStalePolicyPendingOrder(order)) {
    order.status = "failed";
    order.failureReason = "stale_pending_policy_order";
    order.updatedAt = repository.nowIso();
    await repository.updateTopupOrder(order);
    return {
      status: "failed" as const,
      orderId: order.orderId,
      reason: order.failureReason
    };
  }

  const record = await input.gateway.getTransactionByRequestId({
    walletId: input.walletId,
    requestId: order.orderId
  });

  if (!record) {
    return {
      status: "missing_caw_record" as const,
      orderId: order.orderId
    };
  }

  const txHash = record.txHash && isTransactionHash(record.txHash) ? record.txHash : undefined;
  if (txHash && order.txHash !== txHash) {
    order.txHash = txHash;
  }

  const cawStatus = classifyCawTransaction(record);
  if (cawStatus === "failed") {
    order.status = "failed";
    order.failureReason = `caw_${normalizeCawStatus(record)}`;
    order.updatedAt = repository.nowIso();
    await repository.updateTopupOrder(order);
    return {
      status: "failed" as const,
      orderId: order.orderId,
      reason: order.failureReason
    };
  }

  if (cawStatus === "pending_approval") {
    order.status = "pending_approval";
    order.updatedAt = repository.nowIso();
    await repository.updateTopupOrder(order);
    return {
      status: "pending_approval" as const,
      orderId: order.orderId
    };
  }

  if (cawStatus === "processing") {
    order.status = txHash ? "chain_pending" : "caw_submitted";
    order.updatedAt = repository.nowIso();
    await repository.updateTopupOrder(order);
    return {
      status: order.status,
      orderId: order.orderId
    };
  }

  order.status = "chain_pending";
  order.updatedAt = repository.nowIso();
  await repository.updateTopupOrder(order);

  if (!txHash) {
    return {
      status: "chain_pending" as const,
      orderId: order.orderId,
      reason: "missing_transaction_hash"
    };
  }

  const receipt = await verifyCreditsPaymentReceipt(order);
  if (!receipt.ok) {
    return {
      status: "chain_pending" as const,
      orderId: order.orderId,
      reason: receipt.reason
    };
  }

  const settlement = await settleCreditsPurchase({
    orderId: order.orderId,
    onchainOrderId: order.onchainOrderId,
    amountUsdcMinor: order.amountUsdcMinor,
    txHash,
    eventId: `caw:${record.id}:${order.orderId}`
  });

  return {
    status: settlement.status,
    orderId: order.orderId
  };
}

function classifyCawTransaction(record: CawTransactionRecord) {
  if (record.statusCode === 900 || ["success", "completed"].includes(normalizeCawStatus(record))) {
    return "success" as const;
  }
  if (
    record.statusCode !== undefined &&
    record.statusCode >= 901 &&
    record.statusCode <= 903
  ) {
    return "failed" as const;
  }

  const status = normalizeCawStatus(record);
  if (["failed", "rejected", "cancelled", "canceled"].includes(status)) {
    return "failed" as const;
  }
  if (status.includes("approval") || status.includes("authorization")) {
    return "pending_approval" as const;
  }
  return "processing" as const;
}

function normalizeCawStatus(record: CawTransactionRecord) {
  return `${record.status} ${record.subStatus ?? ""}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

async function checkAuthorizationPolicy(userId: string, amountUsdcMinor: number) {
  const repository = getCreditRepository();
  const authorization = await repository.getActiveAuthorization(userId);

  if (!authorization) {
    return { ok: false as const, reason: "missing_caw_authorization" };
  }

  refreshAuthorizationWindows(authorization);

  if (authorization.status !== "active") {
    return { ok: false as const, reason: `authorization_${authorization.status}` };
  }

  if (Date.parse(authorization.expiresAt) <= Date.now()) {
    authorization.status = "expired";
    await repository.updateAuthorization(authorization);
    return { ok: false as const, reason: "authorization_expired" };
  }

  if (amountUsdcMinor > authorization.singleLimitUsdcMinor) {
    return { ok: false as const, reason: "single_limit_exceeded" };
  }

  if (authorization.spentTodayUsdcMinor + amountUsdcMinor > authorization.dailyLimitUsdcMinor) {
    return { ok: false as const, reason: "daily_limit_exceeded" };
  }

  if (authorization.spentMonthUsdcMinor + amountUsdcMinor > authorization.monthlyLimitUsdcMinor) {
    return { ok: false as const, reason: "monthly_limit_exceeded" };
  }

  return { ok: true as const, authorization };
}

async function checkRealPaymentPreflight(input: {
  userId: string;
  walletId: string;
  walletAddress: string;
  pactId: string;
  amountUsdcMinor: number;
}) {
  const user = await getCreditRepository().requireUser(input.userId);
  const runtime = await getUserRuntimeStatusForBoundWallet(input.userId, user);
  if (runtime.mode !== "http") {
    return { ok: true as const };
  }
  if (input.pactId.startsWith("mock_")) {
    return { ok: false as const, reason: "mock_pact_not_allowed_for_real_payment" };
  }
  if (!input.walletAddress) {
    return { ok: false as const, reason: "missing_caw_wallet_address" };
  }

  const readiness = await getOnchainSpendReadiness({
    walletAddress: input.walletAddress,
    paymentContractAddress: requiredPaymentContractAddress(),
    requiredUsdcMinor: input.amountUsdcMinor
  });

  if (readiness.error) {
    return { ok: false as const, reason: "onchain_readiness_unavailable" };
  }
  if ((readiness.walletUsdcMinor ?? 0) < input.amountUsdcMinor) {
    return { ok: false as const, reason: "insufficient_usdc_balance" };
  }
  if ((readiness.allowanceUsdcMinor ?? 0) < input.amountUsdcMinor) {
    return { ok: false as const, reason: "insufficient_usdc_allowance" };
  }
  if ((readiness.gasEthWei ?? 0n) <= 0n) {
    return { ok: false as const, reason: "insufficient_base_sepolia_eth_gas" };
  }

  return { ok: true as const };
}

async function verifyCreditsPaymentReceipt(order: TopupOrder) {
  if (!order.txHash || !isTransactionHash(order.txHash)) {
    return { ok: false as const, reason: "payment_tx_hash_missing" };
  }

  try {
    const client = createConfiguredPublicClient();
    const receipt = await client.getTransactionReceipt({
      hash: order.txHash as `0x${string}`
    });
    const paymentContractAddress = getAddress(requiredPaymentContractAddress());

    if (receipt.status !== "success") {
      return { ok: false as const, reason: "payment_transaction_not_successful" };
    }
    if (!receipt.to || getAddress(receipt.to) !== paymentContractAddress) {
      return { ok: false as const, reason: "payment_contract_mismatch" };
    }

    return { ok: true as const };
  } catch (error) {
    return {
      ok: false as const,
      reason: error instanceof Error ? `payment_receipt_unavailable:${error.message}` : "payment_receipt_unavailable"
    };
  }
}

function createConfiguredPublicClient() {
  const viemChain = process.env.CHAIN_ENV === "base-mainnet" ? base : baseSepolia;
  const rpcUrl =
    process.env.BASE_RPC_URL ||
    (process.env.CHAIN_ENV === "base-mainnet" ? "https://mainnet.base.org" : "https://sepolia.base.org");

  return createPublicClient({
    chain: viemChain,
    transport: http(rpcUrl)
  });
}

function isTransactionHash(value: string): value is `0x${string}` {
  return /^0x[a-fA-F0-9]{64}$/.test(value);
}

function requiredPaymentContractAddress() {
  const address = process.env.PAYMENT_CONTRACT_ADDRESS;
  if (!address) {
    throw new Error("PAYMENT_CONTRACT_ADDRESS is required for real payments.");
  }
  return address;
}

async function requireVeniceCliWallet(userId: string) {
  const onboarding = await getCreditRepository().getCawOnboardingSession(userId);
  if (onboarding?.status !== "wallet_active") {
    throw new Error("Venice x402 requires a CAW wallet created through the CLI onboarding flow.");
  }
  return onboarding;
}

function normalizeVenicePactLimits(input: {
  amountUsdcMinor?: number;
  dailyLimitUsdcMinor?: number;
  monthlyLimitUsdcMinor?: number;
  validDays?: number;
}) {
  const singleLimitUsdcMinor = positiveMinor(
    input.amountUsdcMinor,
    DEFAULT_VENICE_PACT_LIMITS.singleLimitUsdcMinor
  );
  const dailyLimitUsdcMinor = Math.max(
    singleLimitUsdcMinor,
    positiveMinor(input.dailyLimitUsdcMinor, DEFAULT_VENICE_PACT_LIMITS.dailyLimitUsdcMinor)
  );
  const monthlyLimitUsdcMinor = Math.max(
    dailyLimitUsdcMinor,
    positiveMinor(input.monthlyLimitUsdcMinor, DEFAULT_VENICE_PACT_LIMITS.monthlyLimitUsdcMinor)
  );
  const validDays =
    Number.isFinite(input.validDays) && Number(input.validDays) > 0
      ? Math.floor(Number(input.validDays))
      : DEFAULT_VENICE_PACT_LIMITS.validDays;

  return {
    singleLimitUsdcMinor,
    dailyLimitUsdcMinor,
    monthlyLimitUsdcMinor,
    validDays
  };
}

function buildVeniceX402PactPreview(input: {
  accept: VeniceX402Accept;
  limits: CawPactPreview["limits"];
}): CawPactPreview {
  const usdcAddress = getAddress(BASE_CHAIN.usdcAddress);
  const payTo = getAddress(input.accept.payTo);
  const amountWarning = veniceRequirementWarning(input.accept, input.limits.singleLimitUsdcMinor);
  const warnings = [
    "This Pact is for Venice x402 top-up on Base mainnet USDC only.",
    `Venice x402 payTo address discovered from the 402 requirement: ${payTo}.`,
    ...(amountWarning ? [amountWarning] : [])
  ];

  return {
    intent:
      `Authorize Venice AI x402 top-ups on Base mainnet using USDC. ` +
      `Each top-up is capped at ${formatUsdc(input.limits.singleLimitUsdcMinor)} USDC; ` +
      `total spend is capped at ${formatUsdc(input.limits.monthlyLimitUsdcMinor)} USDC while this Pact is valid.`,
    originalIntent:
      `Create a Venice x402 top-up Pact for Base mainnet USDC. ` +
      `Selected x402 network: BASE_ETH. CAW token ID: ${VENICE_USDC_TOKEN_ID}. ` +
      `USDC token: ${usdcAddress}. Venice payTo: ${payTo}.`,
    executionPlan: [
      `- Discover Venice x402 payment requirements from ${getVeniceTopupPathForPreview()} without spending funds.`,
      `- Select only Base mainnet (BASE_ETH) with native USDC (${usdcAddress}).`,
      `- Execute Venice top-up through CAW CLI x402 with max amount ${input.limits.singleLimitUsdcMinor} minor USDC units.`,
      "- Refuse the payment if Venice requests a different chain, a different asset, or an amount above the configured cap.",
      "- Stop after the Venice API returns a successful top-up response; do not use this Pact for CreditsPayment or other contracts."
    ].join("\n"),
    policies: [
      {
        name: "venice-x402-base-usdc",
        type: "contract_call",
        rules: {
          effect: "allow",
          when: {
            chain_in: [VENICE_CAW_CHAIN_ID],
            target_in: [
              {
                chain_id: VENICE_CAW_CHAIN_ID,
                contract_addr: usdcAddress
              }
            ]
          },
          deny_if: {
            usage_limits: {
              rolling_24h: {
                tx_count_gt: 10
              }
            }
          }
        },
        priority: 100,
        is_active: true
      }
    ],
    completionConditions: [
      {
        type: "time_elapsed",
        threshold: String(input.limits.validDays * 24 * 60 * 60)
      },
      {
        type: "amount_spent_usd",
        threshold: usdcMinorToUsdString(input.limits.monthlyLimitUsdcMinor)
      }
    ],
    draftedBy: "agent_deterministic",
    warnings,
    limits: input.limits
  };
}

function veniceRequirementWarning(accept: VeniceX402Accept, singleLimitUsdcMinor: number) {
  const requiredMinor = parseVeniceAcceptAmountMinor(accept.maxAmountRequired ?? accept.amount);
  if (requiredMinor === undefined) {
    return undefined;
  }
  if (requiredMinor > singleLimitUsdcMinor) {
    return `Current single top-up cap is below Venice's discovered requirement (${formatUsdc(requiredMinor)} USDC); execution will be refused until the cap is increased.`;
  }
  return `Venice discovered requirement is at most ${formatUsdc(requiredMinor)} USDC for the selected x402 option.`;
}

function parseVeniceAcceptAmountMinor(value: string | undefined) {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return Math.floor(parsed);
}

function positiveMinor(value: number | undefined, fallback: number) {
  return Number.isFinite(value) && Number(value) > 0 ? Math.floor(Number(value)) : fallback;
}

function normalizeCoboId(value: string | undefined) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    throw new Error("Cobo ID is required.");
  }
  if (trimmed.length < 3 || trimmed.length > 128) {
    throw new Error("Cobo ID must be between 3 and 128 characters.");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/.test(trimmed)) {
    throw new Error("Cobo ID can contain letters, numbers, dots, underscores, colons, @, +, and hyphens.");
  }
  return trimmed.toLowerCase();
}

function usdcMinorToUsdString(value: number) {
  return (value / USDC_MINOR_UNITS).toFixed(6).replace(/\.?0+$/, "");
}

function getVeniceTopupPathForPreview() {
  return "/api/v1/x402/top-up";
}

function requireBoundCawWallet(user: User) {
  const walletId = getUserCawWalletId(user);
  if (!walletId || !user.cawWalletAddress) {
    throw new Error("Bind a CAW Wallet UUID to this user before running CAW operations.");
  }

  return {
    walletId,
    walletAddress: user.cawWalletAddress
  };
}

async function createUserCawGateway(userId: string, user?: User) {
  return createCawGateway(await resolveUserCawGatewayConfig(userId, user));
}

async function resolveUserCawGatewayConfig(
  userId: string,
  user?: User
): Promise<CawGatewayConfig> {
  const repository = getCreditRepository();
  const currentUser = user ?? (await repository.requireUser(userId));
  const credential = await repository.getCawRuntimeCredential(userId);
  const walletId = currentUser.cawWalletId ?? credential?.walletId;
  const walletAddress = currentUser.cawWalletAddress ?? credential?.walletAddress;
  const profile = await readCawCliProfileCredentials(userId, walletId).catch(() => undefined);

  return {
    apiUrl: credential?.apiUrl || profile?.apiUrl,
    apiKey: profile?.apiKey,
    walletId,
    walletAddress,
    walletName: credential?.walletName || profile?.walletName,
    allowEnvFallback: false
  };
}

async function getUserRuntimeStatusForBoundWallet(userId: string, user: User) {
  const config = await resolveUserCawGatewayConfig(userId, user);
  return getCawRuntimeStatus({
    ...config,
    useDefaultWallet: false
  });
}

function getUserCawWalletId(user: User) {
  if (user.cawWalletId) {
    return user.cawWalletId;
  }
  return undefined;
}

function normalizeOnboardingStatus(input: {
  phase?: string;
  walletStatus?: string;
  needsInput: boolean;
  lastError?: string;
}): CawOnboardingStatus {
  const phase = input.phase?.toLowerCase();
  const walletStatus = input.walletStatus?.toLowerCase();
  if (walletStatus === "active" || phase === "wallet_active") {
    return "wallet_active";
  }
  if (phase === "error" || input.lastError) {
    return "failed";
  }
  if (input.needsInput) {
    return "waiting_input";
  }
  return "running";
}

async function bindDiscoveredCawWallet(input: {
  user: User;
  walletId: string;
  walletAddress: string;
}) {
  const repository = getCreditRepository();
  const existingWalletUser = await repository.findUserByCawWalletId(input.walletId);
  if (existingWalletUser && existingWalletUser.id !== input.user.id) {
    throw new Error(`This CAW wallet profile is already bound to ${existingWalletUser.email}.`);
  }
  const existingAddressUser = await repository.findUserByCawWalletAddress(input.walletAddress);
  if (existingAddressUser && existingAddressUser.id !== input.user.id) {
    throw new Error(`This CAW wallet is already bound to ${existingAddressUser.email}.`);
  }
  await repository.updateUser({
    ...input.user,
    cawWalletId: input.walletId,
    cawWalletAddress: input.walletAddress
  });
}

function defaultAgentName(email: string) {
  const local = email.split("@")[0]?.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 24);
  return local ? `${local}-agent` : "agent-to-token";
}

async function recordAuthorizationSpend(authorization: CawAuthorization, amountUsdcMinor: number) {
  const repository = getCreditRepository();
  refreshAuthorizationWindows(authorization);
  authorization.spentTodayUsdcMinor += amountUsdcMinor;
  authorization.spentMonthUsdcMinor += amountUsdcMinor;
  await repository.updateAuthorization(authorization);
}

function refreshAuthorizationWindows(authorization: CawAuthorization) {
  const now = new Date();
  const dailyStart = new Date(authorization.dailyWindowStart);
  if (dailyStart.toISOString().slice(0, 10) !== now.toISOString().slice(0, 10)) {
    authorization.spentTodayUsdcMinor = 0;
    authorization.dailyWindowStart = now.toISOString();
  }

  const monthKey = now.toISOString().slice(0, 7);
  if (authorization.monthlyWindowStart.slice(0, 7) !== monthKey) {
    authorization.spentMonthUsdcMinor = 0;
    authorization.monthlyWindowStart = now.toISOString();
  }
}

function estimateAgentCredits(prompt: string) {
  return Math.min(5000, Math.max(750, Math.ceil(prompt.length * 10) + 650));
}

function isStalePolicyPendingOrder(order: { status: string; createdAt: string }) {
  if (order.status !== "pending_policy") {
    return false;
  }

  const createdAt = Date.parse(order.createdAt);
  if (Number.isNaN(createdAt)) {
    return false;
  }

  return Date.now() - createdAt > 30 * 1000;
}

export const STALE_TOPUP_TIMEOUT_MS = 30 * 60 * 1000;

export async function expireStaleTopupOrders(input: {
  userId?: string;
  timeoutMs?: number;
}) {
  const repository = getCreditRepository();
  const userId = input.userId ?? DEMO_USER_ID;
  const timeoutMs =
    Number.isFinite(input.timeoutMs) && Number(input.timeoutMs) > 0
      ? Math.floor(Number(input.timeoutMs))
      : STALE_TOPUP_TIMEOUT_MS;
  const cutoffIso = new Date(Date.now() - timeoutMs).toISOString();
  const pendingOrders = await repository.listPendingTopupOrders(userId);
  const staleStatuses = new Set<TopupOrder["status"]>([
    "pending_policy",
    "pending_approval",
    "caw_submitted",
    "chain_pending"
  ]);
  const expiredOrders: TopupOrder[] = [];
  let failedCount = 0;

  for (const order of pendingOrders) {
    if (!staleStatuses.has(order.status) || order.createdAt > cutoffIso) {
      continue;
    }
    try {
      const updated = await repository.updateTopupOrder({
        ...order,
        status: "approval_expired",
        failureReason: order.failureReason ?? "stale_topup_order_timeout",
        updatedAt: repository.nowIso()
      });
      expiredOrders.push(updated);
    } catch {
      failedCount += 1;
    }
  }

  return {
    cutoffIso,
    timeoutMs,
    expiredCount: expiredOrders.length,
    failedCount,
    expiredOrders
  };
}

export const pricing = {
  creditsPerUsdc: CREDITS_PER_USDC
};
