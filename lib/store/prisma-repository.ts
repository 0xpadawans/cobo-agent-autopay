import { createHash } from "node:crypto";
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
  DashboardSnapshot,
  LedgerEntry,
  TopupOrder,
  VeniceTopupOrder,
  User,
  CawPairingSession,
  CawWalletOnboardingSession,
  CawOnboardingPrompt
} from "@/lib/domain/types";
import { prisma } from "@/lib/store/prisma-client";
import type { ChainEventRecord, CreditRepository } from "@/lib/store/repository";

const pendingTopupStatuses: TopupOrder["status"][] = [
  "pending_policy",
  "caw_submitted",
  "chain_pending",
  "pending_approval"
];

export const prismaRepository: CreditRepository = {
  createId,
  nowIso,
  async snapshotForUser(userId: string): Promise<DashboardSnapshot> {
    await ensureDemoData(userId);
    const user = await requirePrismaUser(userId);
    const account = await requirePrismaCreditAccount(userId);
    const authorization = await prisma.cawAuthorization.findFirst({
      where: { userId, purpose: "credits_payment" },
      orderBy: { createdAt: "desc" }
    });
    const veniceAuthorization = await prisma.cawAuthorization.findFirst({
      where: { userId, purpose: "venice_x402" },
      orderBy: { createdAt: "desc" }
    });
    const [
      pairingSession,
      cawOnboardingSession,
      cawRuntimeCredential,
      topupOrders,
      veniceTopupOrders,
      agents,
      agentRuns,
      ledgerEntries,
      usageEvents
    ] = await Promise.all([
      prisma.cawPairingSession.findUnique({ where: { userId } }),
      prisma.cawWalletOnboardingSession.findUnique({ where: { userId } }),
      prisma.cawRuntimeCredential.findUnique({ where: { userId } }),
      prisma.topupOrder.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: 12
      }),
      prisma.veniceTopupOrder.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: 12
      }),
      prisma.agent.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" }
      }),
      prisma.agentRun.findMany({
        where: { userId },
        orderBy: { startedAt: "desc" },
        take: 12
      }),
      prisma.ledgerEntry.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: 12
      }),
      prisma.agentUsageEvent.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: 12
      })
    ]);
    const mappedTopupOrders = topupOrders.map(mapTopupOrder);
    const chain = getConfiguredChain();
    const creditedOrders = mappedTopupOrders.filter((order) => order.status === "credited");
    const now = Date.now();
    const dayAgo = now - 24 * 60 * 60 * 1000;
    const monthAgo = now - 30 * 24 * 60 * 60 * 1000;
    const credited24h = creditedOrders.filter((order) => Date.parse(order.updatedAt) >= dayAgo);
    const credited30d = creditedOrders.filter((order) => Date.parse(order.updatedAt) >= monthAgo);
    const mappedAuthorization = authorization
      ? mapAuthorization(authorization, { includePactApiKey: false })
      : undefined;
    const mappedVeniceAuthorization = veniceAuthorization
      ? mapAuthorization(veniceAuthorization, { includePactApiKey: false })
      : undefined;

    return {
      user: mapUser(user),
      account: mapCreditAccount(account),
      authorization: mappedAuthorization,
      veniceAuthorization: mappedVeniceAuthorization,
      cawRuntimeCredential: cawRuntimeCredential
        ? mapCawRuntimeCredential(cawRuntimeCredential)
        : undefined,
      pairingSession: pairingSession ? mapPairingSession(pairingSession) : undefined,
      cawOnboardingSession: cawOnboardingSession
        ? mapCawOnboardingSession(cawOnboardingSession)
        : undefined,
      guardrails: {
        singleLimitUsdcMinor:
          mappedAuthorization?.singleLimitUsdcMinor ?? DEFAULT_SPEND_POLICY.singleLimitUsdcMinor,
        dailyLimitUsdcMinor:
          mappedAuthorization?.dailyLimitUsdcMinor ?? DEFAULT_SPEND_POLICY.dailyLimitUsdcMinor,
        reviewThresholdUsdcMinor: DEFAULT_GUARDRAILS.reviewThresholdUsdcMinor,
        allowedAddresses: user.cawWalletAddress ? [user.cawWalletAddress] : [],
        allowedChains: [getConfiguredCawChainId()],
        generatedBy: "system_default",
        updatedAt: mappedAuthorization?.createdAt ?? user.createdAt.toISOString()
      },
      paymentStats: {
        spent24hUsdcMinor: credited24h.reduce((total, order) => total + order.amountUsdcMinor, 0),
        spent30dUsdcMinor: credited30d.reduce((total, order) => total + order.amountUsdcMinor, 0),
        txCount24h: credited24h.length,
        txCount30d: credited30d.length,
        automaticPayments: creditedOrders.filter((order) => order.reason !== "manual").length,
        manualApprovalPayments: mappedTopupOrders.filter(
          (order) => order.status === "pending_approval"
        ).length
      },
      pendingApprovals: mappedTopupOrders.filter((order) => order.status === "pending_approval"),
      pactDetails: mappedAuthorization
        ? {
            reviewIfAmountUsdcMinor: DEFAULT_GUARDRAILS.reviewThresholdUsdcMinor,
            denyIfAmountUsdcMinor: mappedAuthorization.singleLimitUsdcMinor,
            completionTimeElapsedDays: Math.max(
              0,
              Math.ceil(
                (Date.parse(mappedAuthorization.expiresAt) - Date.now()) / (24 * 60 * 60 * 1000)
              )
            ),
            completionAmountSpentUsdcMinor: mappedAuthorization.monthlyLimitUsdcMinor,
            remainingUsdcMinor: Math.max(
              0,
              mappedAuthorization.monthlyLimitUsdcMinor - mappedAuthorization.spentMonthUsdcMinor
            ),
            txCount24hLimit: DEFAULT_GUARDRAILS.rolling24hTxCountLimit,
            amount24hLimitUsdcMinor: DEFAULT_GUARDRAILS.rolling24hAmountUsdcMinor
          }
        : undefined,
      topupOrders: mappedTopupOrders,
      veniceTopupOrders: veniceTopupOrders.map(mapVeniceTopupOrder),
      agents: agents.map(mapAgent),
      agentRuns: agentRuns.map(mapAgentRun),
      ledgerEntries: ledgerEntries.map(mapLedgerEntry),
      usageEvents: usageEvents.map(mapUsageEvent),
      network: {
        chainId: chain.id,
        name: chain.name,
        usdcAddress: chain.usdcAddress
      },
      pricing: {
        creditsPerUsdc: CREDITS_PER_USDC
      }
    };
  },
  async getOrCreateUserByEmail(email: string): Promise<User> {
    const normalizedEmail = normalizeEmail(email);
    const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (existing) {
      await ensureCreditAccount(existing.id);
      return mapUser(existing);
    }

    const userId = createId("usr");
    const created = await prisma.user.create({
      data: {
        id: userId,
        email: normalizedEmail,
        creditAccount: {
          create: {
            balanceCredits: DEFAULT_CREDIT_ACCOUNT.openingBalanceCredits,
            lowBalanceThresholdCredits: DEFAULT_CREDIT_ACCOUNT.lowBalanceThresholdCredits,
            autoTopupCredits: DEFAULT_CREDIT_ACCOUNT.autoTopupCredits
          }
        },
        ledgerEntries: {
          create: {
            id: createId("led"),
            type: "opening_grant",
            creditsDelta: DEFAULT_CREDIT_ACCOUNT.openingBalanceCredits,
            balanceAfterCredits: DEFAULT_CREDIT_ACCOUNT.openingBalanceCredits
          }
        }
      }
    });
    return mapUser(created);
  },
  async findUserByCoboId(coboId: string): Promise<User | undefined> {
    const user = await prisma.user.findFirst({
      where: { coboId: { equals: coboId.toLowerCase() } }
    });
    return user ? mapUser(user) : undefined;
  },
  async findUserByCawWalletId(walletId: string): Promise<User | undefined> {
    const user = await prisma.user.findUnique({ where: { cawWalletId: walletId } });
    return user ? mapUser(user) : undefined;
  },
  async findUserByCawWalletAddress(walletAddress: string): Promise<User | undefined> {
    const user = await prisma.user.findFirst({
      where: { cawWalletAddress: { equals: walletAddress.toLowerCase() } }
    });
    return user ? mapUser(user) : undefined;
  },
  async requireUser(userId: string): Promise<User> {
    await ensureDemoData(userId);
    return mapUser(await requirePrismaUser(userId));
  },
  async requireCreditAccount(userId: string): Promise<CreditAccount> {
    await ensureDemoData(userId);
    return mapCreditAccount(await requirePrismaCreditAccount(userId));
  },
  async updateCreditAccount(account: CreditAccount): Promise<CreditAccount> {
    const updated = await prisma.creditAccount.update({
      where: { userId: account.userId },
      data: {
        balanceCredits: account.balanceCredits,
        lowBalanceThresholdCredits: account.lowBalanceThresholdCredits,
        autoTopupCredits: account.autoTopupCredits
      }
    });
    return mapCreditAccount(updated);
  },
  async updateUser(user: User): Promise<User> {
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        email: user.email,
        coboId: user.coboId,
        coboIdBoundAt: user.coboIdBoundAt ? new Date(user.coboIdBoundAt) : null,
        cawWalletId: user.cawWalletId,
        cawWalletAddress: user.cawWalletAddress
      }
    });
    return mapUser(updated);
  },
  async getActiveAuthorization(
    userId: string,
    purpose: CawAuthorizationPurpose = "credits_payment"
  ): Promise<CawAuthorization | undefined> {
    await ensureDemoData(userId);
    const authorization = await prisma.cawAuthorization.findFirst({
      where: { userId, purpose },
      orderBy: { createdAt: "desc" }
    });
    return authorization ? mapAuthorization(authorization) : undefined;
  },
  async createAuthorization(authorization: CawAuthorization): Promise<CawAuthorization> {
    const created = await prisma.cawAuthorization.create({
      data: {
        id: authorization.id,
        userId: authorization.userId,
        purpose: authorization.purpose,
        walletAddress: authorization.walletAddress,
        pactId: authorization.pactId,
        pactApiKey: authorization.pactApiKey,
        status: authorization.status,
        singleLimitUsdcMinor: authorization.singleLimitUsdcMinor,
        dailyLimitUsdcMinor: authorization.dailyLimitUsdcMinor,
        monthlyLimitUsdcMinor: authorization.monthlyLimitUsdcMinor,
        spentTodayUsdcMinor: authorization.spentTodayUsdcMinor,
        spentMonthUsdcMinor: authorization.spentMonthUsdcMinor,
        dailyWindowStart: new Date(authorization.dailyWindowStart),
        monthlyWindowStart: new Date(authorization.monthlyWindowStart),
        expiresAt: new Date(authorization.expiresAt),
        createdAt: new Date(authorization.createdAt)
      }
    });
    return mapAuthorization(created);
  },
  async updateAuthorization(authorization: CawAuthorization): Promise<CawAuthorization> {
    const updated = await prisma.cawAuthorization.update({
      where: { id: authorization.id },
      data: {
        walletAddress: authorization.walletAddress,
        purpose: authorization.purpose,
        pactId: authorization.pactId,
        pactApiKey: authorization.pactApiKey,
        status: authorization.status,
        singleLimitUsdcMinor: authorization.singleLimitUsdcMinor,
        dailyLimitUsdcMinor: authorization.dailyLimitUsdcMinor,
        monthlyLimitUsdcMinor: authorization.monthlyLimitUsdcMinor,
        spentTodayUsdcMinor: authorization.spentTodayUsdcMinor,
        spentMonthUsdcMinor: authorization.spentMonthUsdcMinor,
        dailyWindowStart: new Date(authorization.dailyWindowStart),
        monthlyWindowStart: new Date(authorization.monthlyWindowStart),
        expiresAt: new Date(authorization.expiresAt)
      }
    });
    return mapAuthorization(updated);
  },
  async createPairingSession(
    userId: string,
    session: CawPairingSession
  ): Promise<CawPairingSession> {
    const created = await prisma.cawPairingSession.upsert({
      where: { userId },
      create: {
        userId,
        code: session.code,
        status: session.status,
        expiresAt: new Date(session.expiresAt),
        createdAt: new Date(session.createdAt)
      },
      update: {
        code: session.code,
        status: session.status,
        expiresAt: new Date(session.expiresAt),
        createdAt: new Date(session.createdAt)
      }
    });
    return mapPairingSession(created);
  },
  async upsertCawRuntimeCredential(input): Promise<CawRuntimeCredential> {
    const updated = await prisma.cawRuntimeCredential.upsert({
      where: { userId: input.userId },
      create: {
        id: createId("crc"),
        userId: input.userId,
        walletId: input.walletId,
        walletAddress: input.walletAddress.toLowerCase(),
        walletName: input.walletName,
        agentId: input.agentId,
        apiUrl: input.apiUrl,
        apiKeyEncrypted: input.apiKeyEncrypted,
        cawHomePath: input.cawHomePath,
        keyVersion: input.keyVersion ?? 1,
        lastVerifiedAt: input.lastVerifiedAt ? new Date(input.lastVerifiedAt) : undefined
      },
      update: {
        walletId: input.walletId,
        walletAddress: input.walletAddress.toLowerCase(),
        walletName: input.walletName,
        agentId: input.agentId,
        apiUrl: input.apiUrl,
        apiKeyEncrypted: input.apiKeyEncrypted,
        cawHomePath: input.cawHomePath,
        keyVersion: input.keyVersion ?? 1,
        lastVerifiedAt: input.lastVerifiedAt ? new Date(input.lastVerifiedAt) : null
      }
    });
    return mapCawRuntimeCredential(updated);
  },
  async getCawRuntimeCredential(userId: string): Promise<CawRuntimeCredential | undefined> {
    const credential = await prisma.cawRuntimeCredential.findUnique({ where: { userId } });
    return credential ? mapCawRuntimeCredential(credential) : undefined;
  },
  async getCawOnboardingSession(
    userId: string
  ): Promise<CawWalletOnboardingSession | undefined> {
    await ensureDemoData(userId);
    const session = await prisma.cawWalletOnboardingSession.findUnique({ where: { userId } });
    return session ? mapCawOnboardingSession(session) : undefined;
  },
  async upsertCawOnboardingSession(
    session: CawWalletOnboardingSession
  ): Promise<CawWalletOnboardingSession> {
    const updated = await prisma.cawWalletOnboardingSession.upsert({
      where: { userId: session.userId },
      create: {
        userId: session.userId,
        sessionId: session.sessionId,
        status: session.status,
        phase: session.phase,
        walletStatus: session.walletStatus,
        needsInput: session.needsInput,
        prompts: JSON.stringify(session.prompts ?? []),
        nextAction: session.nextAction,
        lastError: session.lastError,
        agentName: session.agentName,
        apiUrl: session.apiUrl,
        walletId: session.walletId,
        walletName: session.walletName,
        agentId: session.agentId,
        createdAt: new Date(session.createdAt),
        updatedAt: new Date(session.updatedAt)
      },
      update: {
        sessionId: session.sessionId,
        status: session.status,
        phase: session.phase,
        walletStatus: session.walletStatus,
        needsInput: session.needsInput,
        prompts: JSON.stringify(session.prompts ?? []),
        nextAction: session.nextAction,
        lastError: session.lastError,
        agentName: session.agentName,
        apiUrl: session.apiUrl,
        walletId: session.walletId,
        walletName: session.walletName,
        agentId: session.agentId,
        updatedAt: new Date(session.updatedAt)
      }
    });
    return mapCawOnboardingSession(updated);
  },
  async getOrCreateAgent(input: { userId: string; name: string }): Promise<Agent> {
    const existing = await prisma.agent.findUnique({
      where: { userId_name: { userId: input.userId, name: input.name } }
    });
    if (existing) {
      return mapAgent(existing);
    }
    const created = await prisma.agent.create({
      data: {
        id: createId("agt"),
        userId: input.userId,
        name: input.name
      }
    });
    return mapAgent(created);
  },
  async updateAgent(agent: Agent): Promise<Agent> {
    const updated = await prisma.agent.update({
      where: { id: agent.id },
      data: {
        name: agent.name,
        status: agent.status,
        veniceAutoTopup: agent.veniceAutoTopup,
        veniceTopupUsdMinor: agent.veniceTopupUsdMinor
      }
    });
    return mapAgent(updated);
  },
  async createAgentRun(
    input: Omit<AgentRun, "id" | "startedAt" | "updatedAt" | "completedAt">
  ): Promise<AgentRun> {
    const created = await prisma.agentRun.create({
      data: {
        id: createId("run"),
        userId: input.userId,
        agentId: input.agentId,
        taskName: input.taskName,
        prompt: input.prompt,
        status: input.status,
        resumeAfterOrderId: input.resumeAfterOrderId,
        lastError: input.lastError
      }
    });
    return mapAgentRun(created);
  },
  async updateAgentRun(run: AgentRun): Promise<AgentRun> {
    const updated = await prisma.agentRun.update({
      where: { id: run.id },
      data: {
        status: run.status,
        resumeAfterOrderId: run.resumeAfterOrderId,
        lastError: run.lastError,
        completedAt: run.completedAt ? new Date(run.completedAt) : null
      }
    });
    return mapAgentRun(updated);
  },
  async createVeniceTopupOrder(
    input: Omit<VeniceTopupOrder, "id" | "createdAt" | "updatedAt">
  ): Promise<VeniceTopupOrder> {
    const created = await prisma.veniceTopupOrder.create({
      data: {
        id: createId("vto"),
        userId: input.userId,
        agentId: input.agentId,
        agentRunId: input.agentRunId,
        walletAddress: input.walletAddress.toLowerCase(),
        pactId: input.pactId,
        status: input.status,
        usdAmount: input.usdAmount,
        amountUsdcMinor: input.amountUsdcMinor,
        responseStatus: input.responseStatus,
        responseBodyPreview: input.responseBodyPreview,
        txHash: input.txHash,
        balanceCanConsume: input.balanceCanConsume,
        balanceUsd: input.balanceUsd,
        failureReason: input.failureReason,
        paymentSubmittedAt: input.paymentSubmittedAt ? new Date(input.paymentSubmittedAt) : undefined,
        balanceCheckedAt: input.balanceCheckedAt ? new Date(input.balanceCheckedAt) : undefined
      }
    });
    return mapVeniceTopupOrder(created);
  },
  async updateVeniceTopupOrder(order: VeniceTopupOrder): Promise<VeniceTopupOrder> {
    const updated = await prisma.veniceTopupOrder.update({
      where: { id: order.id },
      data: {
        agentId: order.agentId,
        agentRunId: order.agentRunId,
        walletAddress: order.walletAddress.toLowerCase(),
        pactId: order.pactId,
        status: order.status,
        usdAmount: order.usdAmount,
        amountUsdcMinor: order.amountUsdcMinor,
        responseStatus: order.responseStatus,
        responseBodyPreview: order.responseBodyPreview,
        txHash: order.txHash,
        balanceCanConsume: order.balanceCanConsume,
        balanceUsd: order.balanceUsd,
        failureReason: order.failureReason,
        paymentSubmittedAt: order.paymentSubmittedAt ? new Date(order.paymentSubmittedAt) : null,
        balanceCheckedAt: order.balanceCheckedAt ? new Date(order.balanceCheckedAt) : null
      }
    });
    return mapVeniceTopupOrder(updated);
  },
  async createUsageEvent(
    input: Omit<AgentUsageEvent, "id" | "createdAt">
  ): Promise<AgentUsageEvent> {
    const created = await prisma.agentUsageEvent.create({
      data: {
        ...input,
        id: createId("use")
      }
    });
    return mapUsageEvent(created);
  },
  async appendLedgerEntry(input: Omit<LedgerEntry, "id" | "createdAt">): Promise<LedgerEntry> {
    const created = await prisma.ledgerEntry.create({
      data: {
        id: createId("led"),
        userId: input.userId,
        type: input.type,
        creditsDelta: input.creditsDelta,
        balanceAfterCredits: input.balanceAfterCredits,
        orderId: input.orderId,
        usageEventId: input.usageEventId,
        usdcMinor: input.usdcMinor,
        txHash: input.txHash
      }
    });
    return mapLedgerEntry(created);
  },
  async findPendingTopupOrder(userId: string): Promise<TopupOrder | undefined> {
    const order = await prisma.topupOrder.findFirst({
      where: {
        userId,
        status: { in: pendingTopupStatuses }
      },
      orderBy: { createdAt: "asc" }
    });
    return order ? mapTopupOrder(order) : undefined;
  },
  async listPendingTopupOrders(userId: string): Promise<TopupOrder[]> {
    const orders = await prisma.topupOrder.findMany({
      where: {
        userId,
        status: { in: pendingTopupStatuses }
      },
      orderBy: { createdAt: "asc" }
    });
    return orders.map(mapTopupOrder);
  },
  async createTopupOrder(
    input: Omit<TopupOrder, "id" | "orderId" | "onchainOrderId" | "createdAt" | "updatedAt">
  ): Promise<TopupOrder> {
    const orderId = createId("ord");
    const created = await prisma.topupOrder.create({
      data: {
        id: createId("top"),
        userId: input.userId,
        walletAddress: input.walletAddress,
        status: input.status,
        reason: input.reason,
        orderId,
        onchainOrderId: orderIdToBytes32(orderId),
        amountUsdcMinor: input.amountUsdcMinor,
        credits: input.credits,
        txHash: input.txHash,
        failureReason: input.failureReason,
        creditedAt: input.creditedAt ? new Date(input.creditedAt) : undefined
      }
    });
    return mapTopupOrder(created);
  },
  async updateTopupOrder(order: TopupOrder): Promise<TopupOrder> {
    const updated = await prisma.topupOrder.update({
      where: { id: order.id },
      data: {
        walletAddress: order.walletAddress,
        status: order.status,
        reason: order.reason,
        amountUsdcMinor: order.amountUsdcMinor,
        credits: order.credits,
        txHash: order.txHash,
        failureReason: order.failureReason,
        creditedAt: order.creditedAt ? new Date(order.creditedAt) : null
      }
    });
    return mapTopupOrder(updated);
  },
  async findTopupOrderByOrderId(input: {
    orderId?: string;
    onchainOrderId?: string;
  }): Promise<TopupOrder | undefined> {
    const order = await prisma.topupOrder.findFirst({
      where: {
        OR: [
          ...(input.orderId ? [{ orderId: input.orderId }] : []),
          ...(input.onchainOrderId ? [{ onchainOrderId: input.onchainOrderId }] : [])
        ]
      }
    });
    return order ? mapTopupOrder(order) : undefined;
  },
  async findTopupOrderByTxHash(input: {
    userId: string;
    txHash: string;
  }): Promise<TopupOrder | undefined> {
    const order = await prisma.topupOrder.findFirst({
      where: {
        userId: input.userId,
        txHash: {
          equals: input.txHash.toLowerCase()
        }
      },
      orderBy: {
        createdAt: "desc"
      }
    });
    return order ? mapTopupOrder(order) : undefined;
  },
  async hasChainEvent(eventId: string): Promise<boolean> {
    const count = await prisma.chainEventSeen.count({ where: { eventId } });
    return count > 0;
  },
  async markChainEventSeen(event: ChainEventRecord): Promise<boolean> {
    try {
      await prisma.chainEventSeen.create({
        data: {
          eventId: event.eventId,
          txHash: event.txHash,
          logIndex: event.logIndex,
          orderId: event.orderId
        }
      });
      return true;
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return false;
      }
      throw error;
    }
  }
};

async function ensureDemoData(userId: string) {
  if (userId !== DEMO_USER_ID) {
    return;
  }

  await prisma.user.upsert({
    where: { id: DEMO_USER_ID },
    create: {
      id: DEMO_USER_ID,
      email: DEMO_USER_EMAIL,
      creditAccount: {
        create: {
          balanceCredits: DEFAULT_CREDIT_ACCOUNT.openingBalanceCredits,
          lowBalanceThresholdCredits: DEFAULT_CREDIT_ACCOUNT.lowBalanceThresholdCredits,
          autoTopupCredits: DEFAULT_CREDIT_ACCOUNT.autoTopupCredits
        }
      },
      ledgerEntries: {
        create: {
          id: createId("led"),
          type: "opening_grant",
          creditsDelta: DEFAULT_CREDIT_ACCOUNT.openingBalanceCredits,
          balanceAfterCredits: DEFAULT_CREDIT_ACCOUNT.openingBalanceCredits
        }
      }
    },
    update: {}
  });

  await prisma.creditAccount.upsert({
    where: { userId: DEMO_USER_ID },
    create: {
      userId: DEMO_USER_ID,
      balanceCredits: DEFAULT_CREDIT_ACCOUNT.openingBalanceCredits,
      lowBalanceThresholdCredits: DEFAULT_CREDIT_ACCOUNT.lowBalanceThresholdCredits,
      autoTopupCredits: DEFAULT_CREDIT_ACCOUNT.autoTopupCredits
    },
    update: {}
  });
}

async function ensureCreditAccount(userId: string) {
  await prisma.creditAccount.upsert({
    where: { userId },
    create: {
      userId,
      balanceCredits: DEFAULT_CREDIT_ACCOUNT.openingBalanceCredits,
      lowBalanceThresholdCredits: DEFAULT_CREDIT_ACCOUNT.lowBalanceThresholdCredits,
      autoTopupCredits: DEFAULT_CREDIT_ACCOUNT.autoTopupCredits
    },
    update: {}
  });
}

async function requirePrismaUser(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new Error(`Unknown user: ${userId}`);
  }
  return user;
}

async function requirePrismaCreditAccount(userId: string) {
  const account = await prisma.creditAccount.findUnique({ where: { userId } });
  if (!account) {
    throw new Error(`Missing credit account for user: ${userId}`);
  }
  return account;
}

function createId(prefix: string) {
  const uuid = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `${prefix}_${uuid.replaceAll("-", "").slice(0, 16)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function orderIdToBytes32(orderId: string) {
  return `0x${createHash("sha256").update(orderId).digest("hex")}`;
}

function mapUser(user: {
  id: string;
  email: string;
  coboId: string | null;
  coboIdBoundAt: Date | null;
  cawWalletId: string | null;
  cawWalletAddress: string | null;
  createdAt: Date;
}): User {
  return {
    id: user.id,
    email: user.email,
    coboId: user.coboId ?? undefined,
    coboIdBoundAt: user.coboIdBoundAt?.toISOString(),
    cawWalletId: user.cawWalletId ?? undefined,
    cawWalletAddress: user.cawWalletAddress ?? undefined,
    createdAt: user.createdAt.toISOString()
  };
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function mapPairingSession(session: {
  code: string;
  status: CawPairingSession["status"];
  expiresAt: Date;
  createdAt: Date;
}): CawPairingSession {
  return {
    code: session.code,
    status: session.status,
    expiresAt: session.expiresAt.toISOString(),
    createdAt: session.createdAt.toISOString()
  };
}

function mapCawOnboardingSession(session: {
  userId: string;
  sessionId: string | null;
  status: CawWalletOnboardingSession["status"];
  phase: string | null;
  walletStatus: string | null;
  needsInput: boolean;
  prompts: unknown;
  nextAction: string | null;
  lastError: string | null;
  agentName: string | null;
  apiUrl: string | null;
  walletId: string | null;
  walletName: string | null;
  agentId: string | null;
  createdAt: Date;
  updatedAt: Date;
}): CawWalletOnboardingSession {
  return {
    userId: session.userId,
    sessionId: session.sessionId ?? undefined,
    status: session.status,
    phase: session.phase ?? undefined,
    walletStatus: session.walletStatus ?? undefined,
    needsInput: session.needsInput,
    prompts: normalizePromptList(session.prompts),
    nextAction: session.nextAction ?? undefined,
    lastError: session.lastError ?? undefined,
    agentName: session.agentName ?? undefined,
    apiUrl: session.apiUrl ?? undefined,
    walletId: session.walletId ?? undefined,
    walletName: session.walletName ?? undefined,
    agentId: session.agentId ?? undefined,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString()
  };
}

function normalizePromptList(value: unknown): CawOnboardingPrompt[] {
  // Handle JSON string from SQLite
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed
    .map((entry): CawOnboardingPrompt | undefined => {
      if (typeof entry !== "object" || entry === null) {
        return undefined;
      }
      const record = entry as Record<string, unknown>;
      const id = stringField(record, "id", "");
      if (!id) {
        return undefined;
      }
      return {
        id,
        label: stringField(record, "label", undefined),
        message: stringField(record, "message", undefined),
        type: stringField(record, "type", undefined),
        required: booleanField(record, "required"),
        secret: booleanField(record, "secret"),
        options: arrayStringField(record, "options")
      };
    })
    .filter((entry): entry is CawOnboardingPrompt => Boolean(entry));
}

function mapCreditAccount(account: {
  userId: string;
  balanceCredits: number;
  lowBalanceThresholdCredits: number;
  autoTopupCredits: number;
  updatedAt: Date;
}): CreditAccount {
  return {
    userId: account.userId,
    balanceCredits: account.balanceCredits,
    lowBalanceThresholdCredits: account.lowBalanceThresholdCredits,
    autoTopupCredits: account.autoTopupCredits,
    updatedAt: account.updatedAt.toISOString()
  };
}

function mapAuthorization(
  authorization: {
    id: string;
    userId: string;
    purpose: CawAuthorization["purpose"];
    walletAddress: string;
    pactId: string;
    pactApiKey: string | null;
    status: CawAuthorization["status"];
    singleLimitUsdcMinor: number;
    dailyLimitUsdcMinor: number;
    monthlyLimitUsdcMinor: number;
    spentTodayUsdcMinor: number;
    spentMonthUsdcMinor: number;
    dailyWindowStart: Date;
    monthlyWindowStart: Date;
    expiresAt: Date;
    createdAt: Date;
  },
  options: { includePactApiKey?: boolean } = { includePactApiKey: true }
): CawAuthorization {
  return {
    id: authorization.id,
    userId: authorization.userId,
    purpose: authorization.purpose,
    walletAddress: authorization.walletAddress,
    pactId: authorization.pactId,
    pactApiKey: options.includePactApiKey ? authorization.pactApiKey ?? undefined : undefined,
    status: authorization.status,
    singleLimitUsdcMinor: authorization.singleLimitUsdcMinor,
    dailyLimitUsdcMinor: authorization.dailyLimitUsdcMinor,
    monthlyLimitUsdcMinor: authorization.monthlyLimitUsdcMinor,
    spentTodayUsdcMinor: authorization.spentTodayUsdcMinor,
    spentMonthUsdcMinor: authorization.spentMonthUsdcMinor,
    dailyWindowStart: authorization.dailyWindowStart.toISOString(),
    monthlyWindowStart: authorization.monthlyWindowStart.toISOString(),
    expiresAt: authorization.expiresAt.toISOString(),
    createdAt: authorization.createdAt.toISOString()
  };
}

function mapTopupOrder(order: {
  id: string;
  userId: string;
  walletAddress: string;
  status: TopupOrder["status"];
  reason: string;
  orderId: string;
  onchainOrderId: string;
  amountUsdcMinor: number;
  credits: number;
  txHash: string | null;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  creditedAt: Date | null;
}): TopupOrder {
  return {
    id: order.id,
    userId: order.userId,
    walletAddress: order.walletAddress,
    status: order.status,
    reason: order.reason,
    orderId: order.orderId,
    onchainOrderId: order.onchainOrderId,
    amountUsdcMinor: order.amountUsdcMinor,
    credits: order.credits,
    txHash: order.txHash ?? undefined,
    failureReason: order.failureReason ?? undefined,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
    creditedAt: order.creditedAt?.toISOString()
  };
}

function mapCawRuntimeCredential(credential: {
  id: string;
  userId: string;
  walletId: string;
  walletAddress: string;
  walletName: string | null;
  agentId: string;
  apiUrl: string;
  cawHomePath: string | null;
  keyVersion: number;
  lastVerifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): CawRuntimeCredential {
  return {
    id: credential.id,
    userId: credential.userId,
    walletId: credential.walletId,
    walletAddress: credential.walletAddress,
    walletName: credential.walletName ?? undefined,
    agentId: credential.agentId,
    apiUrl: credential.apiUrl,
    cawHomePath: credential.cawHomePath ?? undefined,
    keyVersion: credential.keyVersion,
    lastVerifiedAt: credential.lastVerifiedAt?.toISOString(),
    createdAt: credential.createdAt.toISOString(),
    updatedAt: credential.updatedAt.toISOString()
  };
}

function mapAgent(agent: {
  id: string;
  userId: string;
  name: string;
  status: Agent["status"];
  veniceAutoTopup: boolean;
  veniceTopupUsdMinor: number;
  createdAt: Date;
  updatedAt: Date;
}): Agent {
  return {
    id: agent.id,
    userId: agent.userId,
    name: agent.name,
    status: agent.status,
    veniceAutoTopup: agent.veniceAutoTopup,
    veniceTopupUsdMinor: agent.veniceTopupUsdMinor,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString()
  };
}

function mapAgentRun(run: {
  id: string;
  userId: string;
  agentId: string;
  taskName: string;
  prompt: string;
  status: AgentRun["status"];
  resumeAfterOrderId: string | null;
  lastError: string | null;
  startedAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}): AgentRun {
  return {
    id: run.id,
    userId: run.userId,
    agentId: run.agentId,
    taskName: run.taskName,
    prompt: run.prompt,
    status: run.status,
    resumeAfterOrderId: run.resumeAfterOrderId ?? undefined,
    lastError: run.lastError ?? undefined,
    startedAt: run.startedAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    completedAt: run.completedAt?.toISOString()
  };
}

function mapVeniceTopupOrder(order: {
  id: string;
  userId: string;
  agentId: string | null;
  agentRunId: string | null;
  walletAddress: string;
  pactId: string;
  status: VeniceTopupOrder["status"];
  usdAmount: number;
  amountUsdcMinor: number;
  responseStatus: number | null;
  responseBodyPreview: string | null;
  txHash: string | null;
  balanceCanConsume: boolean | null;
  balanceUsd: number | null;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  paymentSubmittedAt: Date | null;
  balanceCheckedAt: Date | null;
}): VeniceTopupOrder {
  return {
    id: order.id,
    userId: order.userId,
    agentId: order.agentId ?? undefined,
    agentRunId: order.agentRunId ?? undefined,
    walletAddress: order.walletAddress,
    pactId: order.pactId,
    status: order.status,
    usdAmount: order.usdAmount,
    amountUsdcMinor: order.amountUsdcMinor,
    responseStatus: order.responseStatus ?? undefined,
    responseBodyPreview: order.responseBodyPreview ?? undefined,
    txHash: order.txHash ?? undefined,
    balanceCanConsume: order.balanceCanConsume ?? undefined,
    balanceUsd: order.balanceUsd ?? undefined,
    failureReason: order.failureReason ?? undefined,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
    paymentSubmittedAt: order.paymentSubmittedAt?.toISOString(),
    balanceCheckedAt: order.balanceCheckedAt?.toISOString()
  };
}

function mapLedgerEntry(entry: {
  id: string;
  userId: string;
  type: LedgerEntry["type"];
  creditsDelta: number;
  balanceAfterCredits: number;
  orderId: string | null;
  usageEventId: string | null;
  usdcMinor: number | null;
  txHash: string | null;
  createdAt: Date;
}): LedgerEntry {
  return {
    id: entry.id,
    userId: entry.userId,
    type: entry.type,
    creditsDelta: entry.creditsDelta,
    balanceAfterCredits: entry.balanceAfterCredits,
    orderId: entry.orderId ?? undefined,
    usageEventId: entry.usageEventId ?? undefined,
    usdcMinor: entry.usdcMinor ?? undefined,
    txHash: entry.txHash ?? undefined,
    createdAt: entry.createdAt.toISOString()
  };
}

function mapUsageEvent(event: {
  id: string;
  userId: string;
  taskName: string;
  prompt: string;
  estimatedCredits: number;
  creditsCharged: number;
  status: AgentUsageEvent["status"];
  createdAt: Date;
}): AgentUsageEvent {
  return {
    id: event.id,
    userId: event.userId,
    taskName: event.taskName,
    prompt: event.prompt,
    estimatedCredits: event.estimatedCredits,
    creditsCharged: event.creditsCharged,
    status: event.status,
    createdAt: event.createdAt.toISOString()
  };
}

function stringField<T extends string | undefined>(
  source: Record<string, unknown>,
  key: string,
  fallback: T
): string | T {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function booleanField(source: Record<string, unknown>, key: string) {
  const value = source[key];
  return typeof value === "boolean" ? value : undefined;
}

function arrayStringField(source: Record<string, unknown>, key: string) {
  const value = source[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value.filter((entry): entry is string => typeof entry === "string");
  return strings.length ? strings : undefined;
}

function isUniqueConstraintError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}
