import { getConfiguredCawChainId, getConfiguredChain } from "@/lib/domain/constants";
import {
  Configuration,
  FaucetApi,
  PactsApi,
  TransactionRecordsApi,
  TransactionsApi,
  WalletsApi
} from "@cobo/agentic-wallet";
import { encodeFunctionData } from "viem";

type PactSubmitSpec = NonNullable<Parameters<PactsApi["submitPact"]>[0]["spec"]>;

export type CreatePactInput = {
  userId: string;
  walletId?: string;
  walletAddress: string;
  contractAddress?: string;
  usdcAddress: string;
  singleLimitUsdcMinor: number;
  dailyLimitUsdcMinor: number;
  monthlyLimitUsdcMinor: number;
  expiresAt: string;
  pactIntent: string;
  originalIntent: string;
  executionPlan: string;
  policies: unknown[];
  completionConditions: unknown[];
};

export type ExecuteCreditsPurchaseInput = {
  userId: string;
  walletId?: string;
  walletAddress: string;
  pactId: string;
  pactApiKey?: string;
  paymentContractAddress?: string;
  usdcAddress: string;
  orderId: string;
  onchainOrderId: string;
  amountUsdcMinor: number;
  credits: number;
};

export type ExecuteUsdcApprovalInput = {
  userId: string;
  walletId?: string;
  walletAddress: string;
  pactId: string;
  pactApiKey?: string;
  spenderAddress?: string;
  usdcAddress: string;
  amountUsdcMinor: number;
};

export type CawPactStatus = {
  pactId: string;
  status: "pending_user_approval" | "active" | "expired" | "revoked";
  pactApiKey?: string;
};

export type CawTransactionRecord = {
  id: string;
  walletId: string;
  pactId?: string;
  type: string;
  requestType?: string;
  chainId: string;
  tokenId: string;
  from: string;
  to: string;
  amount: string;
  status: string;
  statusCode?: number;
  subStatus?: string;
  txHash?: string;
  requestId?: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
};

export type CawGateway = {
  createPairingCode(input: { userId: string; walletId?: string }): Promise<{
    code: string;
    expiresAt: string;
    status: "generated";
  }>;
  connectWallet(input: {
    userId: string;
    walletId?: string;
    walletAddress?: string;
  }): Promise<{ connectionId: string; walletId?: string; walletAddress: string }>;
  createPact(input: CreatePactInput): Promise<{
    pactId: string;
    status: "active" | "pending_user_approval";
    approvalUrl?: string;
    pactApiKey?: string;
  }>;
  getPact(input: { pactId: string }): Promise<CawPactStatus>;
  requestFaucet(input: { walletAddress: string; tokenId?: string }): Promise<{
    address: string;
    tokenId: string;
    amount: string;
  }>;
  executeCreditsPurchase(input: ExecuteCreditsPurchaseInput): Promise<{
    txHash: string;
    status: "submitted" | "confirmed";
    mockConfirmed: boolean;
  }>;
  executeUsdcApproval(input: ExecuteUsdcApprovalInput): Promise<{
    txHash: string;
    status: "submitted" | "confirmed";
  }>;
  listTransactions(input: {
    walletId?: string;
    limit?: number;
  }): Promise<CawTransactionRecord[]>;
  getTransactionByRequestId(input: {
    walletId?: string;
    requestId: string;
  }): Promise<CawTransactionRecord | undefined>;
};

export type CawRuntimeStatus = {
  mode: "mock" | "http";
  environment: "dev" | "prod" | "unknown";
  apiConfigured: boolean;
  walletConfigured: boolean;
  walletId?: string;
  walletName?: string;
  walletStatus?: string;
  walletAddress?: string;
  walletPaired: boolean;
  pairTokenStatus?: string;
  chainId: string;
  chainName: string;
  faucetTokenId: string;
  paymentContractConfigured: boolean;
  treasuryConfigured: boolean;
  missing: string[];
  error?: string;
};

export type CawGatewayConfig = {
  apiUrl?: string;
  apiKey?: string;
  walletId?: string;
  walletAddress?: string;
  walletName?: string;
  allowEnvFallback?: boolean;
};

class MockCawGateway implements CawGateway {
  async createPairingCode(input: { userId: string; walletId?: string }) {
    const seed = input.userId.replace(/[^a-z0-9]/gi, "").slice(-5).toUpperCase() || "DEMO1";
    return {
      code: `CAW-${seed}`,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      status: "generated" as const
    };
  }

  async connectWallet(input: { userId: string; walletId?: string; walletAddress?: string }) {
    const walletId = input.walletId || `mock_wallet_${input.userId}`;
    return {
      connectionId: `mock_conn_${input.userId}`,
      walletId,
      walletAddress: input.walletAddress || `0x${input.userId.replace(/[^a-f0-9]/gi, "").padEnd(40, "0").slice(0, 40)}`
    };
  }

  async createPact(input: CreatePactInput) {
    const suffix = input.walletAddress.slice(2, 10).toLowerCase();
    return {
      pactId: `mock_pact_${suffix}`,
      status: "active" as const,
      pactApiKey: `mock_pact_key_${suffix}`
    };
  }

  async getPact(input: { pactId: string }) {
    return {
      pactId: input.pactId,
      status: "active" as const,
      pactApiKey: `mock_pact_key_${input.pactId.slice(-8)}`
    };
  }

  async requestFaucet(input: { walletAddress: string; tokenId?: string }) {
    return {
      address: input.walletAddress,
      tokenId: input.tokenId ?? getDefaultFaucetTokenId(),
      amount: "mock"
    };
  }

  async executeCreditsPurchase(input: ExecuteCreditsPurchaseInput) {
    return {
      txHash: `0xmock${input.onchainOrderId.slice(2, 62)}`,
      status: "confirmed" as const,
      mockConfirmed: true
    };
  }

  async executeUsdcApproval(input: ExecuteUsdcApprovalInput) {
    return {
      txHash: `0xmockapprove${input.amountUsdcMinor.toString(16).padStart(48, "0")}`,
      status: "confirmed" as const
    };
  }

  async listTransactions() {
    return [];
  }

  async getTransactionByRequestId() {
    return undefined;
  }
}

class HttpCawGateway implements CawGateway {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly defaultWalletId?: string;
  private readonly defaultWalletAddress?: string;

  constructor(config: CawGatewayConfig = {}) {
    this.baseUrl = requiredConfigAlias(
      config.apiUrl,
      ["AGENT_WALLET_API_URL", "CAW_API_BASE_URL"],
      config.allowEnvFallback !== false
    ).replace(
      /\/$/,
      ""
    );
    this.apiKey = requiredConfigAlias(
      config.apiKey,
      ["AGENT_WALLET_API_KEY", "CAW_API_KEY"],
      config.allowEnvFallback !== false
    );
    this.defaultWalletId =
      config.walletId ||
      (config.allowEnvFallback === false
        ? undefined
        : process.env.AGENT_WALLET_WALLET_ID || process.env.CAW_WALLET_ID);
    this.defaultWalletAddress =
      config.walletAddress ||
      (config.allowEnvFallback === false ? undefined : process.env.CAW_WALLET_ADDRESS);
  }

  async createPairingCode(input: { userId: string; walletId?: string }) {
    const walletId = this.resolveWalletId(input.walletId);
    const result = (
      await this.walletsApi().initiateWalletPair({
        wallet_id: walletId
      })
    ).data.result;

    return {
      code: result.token,
      expiresAt: result.expires_at,
      status: "generated" as const
    };
  }

  async connectWallet(input: { userId: string; walletId?: string; walletAddress?: string }) {
    const walletId = this.resolveWalletId(input.walletId);
    const addresses = (await this.walletsApi().listWalletAddresses(walletId)).data.result;
    const firstAddress = Array.isArray(addresses) ? addresses[0] : undefined;
    const source = (firstAddress ?? {}) as Record<string, unknown>;

    return {
      connectionId: walletId,
      walletId,
      walletAddress:
        stringField(source, "address", "") ||
        stringField(source, "addr", "") ||
        this.defaultWalletAddress ||
        input.walletAddress ||
        ""
    };
  }

  async createPact(input: CreatePactInput) {
    const walletId = this.resolveWalletId(input.walletId);
    requiredInput(input.contractAddress, "PAYMENT_CONTRACT_ADDRESS");
    const response = await this.pactsApi().submitPact({
      wallet_id: walletId,
      name: "Agent credits auto top-up",
      intent: input.pactIntent,
      original_intent: input.originalIntent,
      spec: {
        policies: input.policies as PactSubmitSpec["policies"],
        completion_conditions: input.completionConditions as PactSubmitSpec["completion_conditions"],
        execution_plan: input.executionPlan
      }
    });

    const pactId = response.data.result.pact_id;
    const pact = await this.getPact({ pactId }).catch(() => undefined);
    const status = pact?.status === "active" ? ("active" as const) : ("pending_user_approval" as const);

    return {
      pactId,
      status,
      pactApiKey: pact?.pactApiKey
    };
  }

  async getPact(input: { pactId: string }) {
    const pact = (await this.pactsApi().getPact(input.pactId)).data.result;
    return {
      pactId: pact.id,
      status: normalizePactStatus(pact.status),
      pactApiKey: pact.api_key
    };
  }

  async requestFaucet(input: { walletAddress: string; tokenId?: string }) {
    const response = await this.faucetApi().deposit({
      address: input.walletAddress,
      token_id: input.tokenId ?? getDefaultFaucetTokenId()
    });
    const result = response.data.result;
    return {
      address: result.address,
      tokenId: result.token_id,
      amount: result.amount
    };
  }

  async executeCreditsPurchase(input: ExecuteCreditsPurchaseInput) {
    const walletId = this.resolveWalletId(input.walletId);
    const pactApiKey = input.pactApiKey || process.env.CAW_PACT_API_KEY;
    if (!pactApiKey) {
      throw new Error(
        "CAW Pact is not active yet. Ask the user to approve it in Cobo App, then refresh authorization before paying."
      );
    }

    const calldata = encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "buyCredits",
          stateMutability: "nonpayable",
          inputs: [
            { name: "orderId", type: "bytes32" },
            { name: "creditAccount", type: "address" },
            { name: "amountUsdc", type: "uint256" }
          ],
          outputs: []
        }
      ],
      functionName: "buyCredits",
      args: [
        input.onchainOrderId as `0x${string}`,
        input.walletAddress as `0x${string}`,
        BigInt(input.amountUsdcMinor)
      ]
    });

    const result = (
      await this.transactionsApi(pactApiKey).contractCall(walletId, {
        chain_id: getConfiguredCawChainId(),
        src_addr: input.walletAddress,
        contract_addr: requiredInput(input.paymentContractAddress, "PAYMENT_CONTRACT_ADDRESS"),
        value: "0",
        calldata,
        request_id: input.orderId,
        description: `Agent credits top-up ${input.orderId}`
      })
    ).data.result;

    return {
      txHash: result.transaction_hash ?? result.id ?? "",
      status: result.status >= 900 ? ("confirmed" as const) : ("submitted" as const),
      mockConfirmed: false
    };
  }

  async executeUsdcApproval(input: ExecuteUsdcApprovalInput) {
    const walletId = this.resolveWalletId(input.walletId);
    const pactApiKey = input.pactApiKey || process.env.CAW_PACT_API_KEY;
    if (!pactApiKey) {
      throw new Error(
        "CAW Pact is not active yet. Ask the user to approve it in Cobo App, then refresh authorization before approving USDC."
      );
    }

    const calldata = encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "approve",
          stateMutability: "nonpayable",
          inputs: [
            { name: "spender", type: "address" },
            { name: "amount", type: "uint256" }
          ],
          outputs: [{ type: "bool" }]
        }
      ],
      functionName: "approve",
      args: [
        requiredInput(input.spenderAddress, "PAYMENT_CONTRACT_ADDRESS") as `0x${string}`,
        BigInt(input.amountUsdcMinor)
      ]
    });

    const result = (
      await this.transactionsApi(pactApiKey).contractCall(walletId, {
        chain_id: getConfiguredCawChainId(),
        src_addr: input.walletAddress,
        contract_addr: input.usdcAddress,
        value: "0",
        calldata,
        request_id: `approve-usdc-${Date.now()}`,
        description: `Approve USDC for CreditsPayment ${input.amountUsdcMinor}`
      })
    ).data.result;

    return {
      txHash: result.transaction_hash ?? result.id ?? "",
      status: result.status >= 900 ? ("confirmed" as const) : ("submitted" as const)
    };
  }

  async listTransactions(input: { walletId?: string; limit?: number }) {
    const walletId = this.resolveWalletId(input.walletId);
    const response = await this.transactionRecordsApi().listUserTransactions(
      walletId,
      undefined,
      undefined,
      undefined,
      clampLimit(input.limit),
      undefined,
      undefined,
      undefined,
      getConfiguredCawChainId(),
      undefined,
      true
    );

    return response.data.result.map(mapCawTransactionRecord);
  }

  async getTransactionByRequestId(input: { walletId?: string; requestId: string }) {
    const walletId = this.resolveWalletId(input.walletId);
    try {
      const response = await this.transactionRecordsApi().getUserTransactionByRequestId(
        walletId,
        input.requestId,
        true
      );
      return mapCawTransactionRecord(response.data.result);
    } catch (error) {
      if (isHttpStatus(error, 404)) {
        return undefined;
      }
      throw error;
    }
  }

  private ownerConfig() {
    return new Configuration({ apiKey: this.apiKey, basePath: this.baseUrl });
  }

  private pactConfig(apiKey: string) {
    return new Configuration({ apiKey, basePath: this.baseUrl });
  }

  private walletsApi() {
    return new WalletsApi(this.ownerConfig());
  }

  private pactsApi() {
    return new PactsApi(this.ownerConfig());
  }

  private transactionsApi(pactApiKey: string) {
    return new TransactionsApi(this.pactConfig(pactApiKey));
  }

  private transactionRecordsApi() {
    return new TransactionRecordsApi(this.ownerConfig());
  }

  private faucetApi() {
    return new FaucetApi(this.ownerConfig());
  }

  private resolveWalletId(walletId?: string) {
    const resolved = walletId || this.defaultWalletId;
    if (!resolved) {
      throw new Error("CAW wallet id is required. Bind a CAW Wallet UUID to this user first.");
    }
    return resolved;
  }
}

function clampLimit(limit: number | undefined) {
  if (!limit || !Number.isFinite(limit)) {
    return 50;
  }
  return Math.min(200, Math.max(1, Math.floor(limit)));
}

function mapCawTransactionRecord(record: {
  id: string;
  wallet_id: string;
  pact_id?: string;
  type: unknown;
  request_type?: unknown;
  chain_id: string;
  token_id: string;
  src_address: string;
  dst_address: string;
  amount: string;
  status: number;
  status_display?: string;
  sub_status?: string;
  transaction_hash?: string;
  request_id?: string;
  description?: string;
  created_at: string;
  updated_at: string;
  ext_transactions?: Array<{ transaction_hash?: string }>;
}): CawTransactionRecord {
  const extTxHash = record.ext_transactions?.find((tx) => tx.transaction_hash)?.transaction_hash;
  return {
    id: record.id,
    walletId: record.wallet_id,
    pactId: record.pact_id,
    type: String(record.type),
    requestType: record.request_type ? String(record.request_type) : undefined,
    chainId: record.chain_id,
    tokenId: record.token_id,
    from: record.src_address,
    to: record.dst_address,
    amount: record.amount,
    status: record.status_display ?? String(record.status),
    statusCode: record.status,
    subStatus: record.sub_status,
    txHash: record.transaction_hash || extTxHash,
    requestId: record.request_id,
    description: record.description,
    createdAt: record.created_at,
    updatedAt: record.updated_at
  };
}

function isHttpStatus(error: unknown, status: number) {
  if (!isRecord(error) || !isRecord(error.response)) {
    return false;
  }
  return error.response.status === status;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function createCawGateway(config: CawGatewayConfig = {}): CawGateway {
  return getConfiguredCawMode() === "mock" ? new MockCawGateway() : new HttpCawGateway(config);
}

export async function getCawRuntimeStatus(input: {
  walletId?: string;
  walletName?: string;
  walletAddress?: string;
  apiUrl?: string;
  apiKey?: string;
  useDefaultWallet?: boolean;
} = {}): Promise<CawRuntimeStatus> {
  const mode = getConfiguredCawMode();
  const apiUrl = input.apiUrl || process.env.AGENT_WALLET_API_URL || process.env.CAW_API_BASE_URL || "";
  const apiKey = input.apiKey || process.env.AGENT_WALLET_API_KEY || process.env.CAW_API_KEY || "";
  const defaultWalletId = process.env.AGENT_WALLET_WALLET_ID || process.env.CAW_WALLET_ID || "";
  const walletId = input.walletId || (input.useDefaultWallet === false ? "" : defaultWalletId);
  const chain = getConfiguredChain();
  const chainId = getConfiguredCawChainId();
  const baseStatus: CawRuntimeStatus = {
    mode,
    environment: inferCawEnvironment(apiUrl),
    apiConfigured: Boolean(apiUrl && apiKey),
    walletConfigured: Boolean(walletId),
    walletId: walletId || undefined,
    walletName: input.walletName,
    walletPaired: mode === "mock",
    chainId,
    chainName: chain.name,
    faucetTokenId: getDefaultFaucetTokenId(),
    paymentContractConfigured: Boolean(process.env.PAYMENT_CONTRACT_ADDRESS),
    treasuryConfigured: Boolean(process.env.TREASURY_ADDRESS),
    missing: []
  };

  baseStatus.missing = getRuntimeMissingItems(baseStatus);

  if (mode === "mock") {
    return {
      ...baseStatus,
      walletName: "Mock CAW wallet",
      walletStatus: "mock_active",
      walletAddress: input.walletAddress || process.env.CAW_WALLET_ADDRESS || undefined
    };
  }

  if (!apiUrl || !apiKey || !walletId) {
    return baseStatus;
  }

  try {
    const config = new Configuration({ apiKey, basePath: apiUrl.replace(/\/$/, "") });
    const walletsApi = new WalletsApi(config);
    const [walletResponse, addressResponse, pairResponse] = await Promise.all([
      walletsApi.getWallet(walletId).catch((error: unknown) => ({ error })),
      walletsApi.listWalletAddresses(walletId).catch((error: unknown) => ({ error })),
      walletsApi.getPairInfoByWallet(walletId).catch((error: unknown) => ({ error }))
    ]);

    const walletResult =
      "error" in walletResponse ? undefined : walletResponse.data.result;
    const addressResult =
      "error" in addressResponse && addressResponse.error
        ? undefined
        : "data" in addressResponse
          ? addressResponse.data.result
          : undefined;
    const pairResult =
      "error" in pairResponse && pairResponse.error
        ? undefined
        : "data" in pairResponse
          ? pairResponse.data.result
          : undefined;
    const firstAddress = Array.isArray(addressResult)
      ? addressResult.find((address) =>
          stringField(address as unknown as Record<string, unknown>, "address", "").startsWith("0x")
        ) ??
        addressResult[0]
      : undefined;
    const pairTokenStatus = pairResult?.token_status;
    const walletPaired = pairTokenStatus === "paired" || pairTokenStatus === "completed";
    const status = {
      ...baseStatus,
      walletName: walletResult?.name,
      walletStatus: walletResult?.status,
      walletAddress: firstAddress?.address || input.walletAddress,
      walletPaired,
      pairTokenStatus
    };

    return {
      ...status,
      missing: getRuntimeMissingItems(status)
    };
  } catch (error) {
    return {
      ...baseStatus,
      error: error instanceof Error ? error.message : "Unable to query CAW runtime status."
    };
  }
}

function getConfiguredCawMode(): CawRuntimeStatus["mode"] {
  if (process.env.CAW_MODE === "mock" && process.env.CAW_ALLOW_MOCK === "true") {
    return "mock";
  }
  return "http";
}

function inferCawEnvironment(apiUrl: string): CawRuntimeStatus["environment"] {
  if (apiUrl.includes(".dev.") || apiUrl.includes("dev.")) {
    return "dev";
  }
  if (apiUrl) {
    return "prod";
  }
  return "unknown";
}

function getRuntimeMissingItems(status: Omit<CawRuntimeStatus, "missing">) {
  const missing: string[] = [];

  if (status.mode === "http" && !status.apiConfigured) {
    missing.push("CAW API URL/API key");
  }
  if (status.mode === "http" && !status.walletConfigured) {
    missing.push("CAW wallet id");
  }
  if (status.mode === "http" && !status.walletPaired) {
    missing.push("CAW App pairing");
  }
  if (!status.paymentContractConfigured) {
    missing.push("payment contract address");
  }
  if (!status.treasuryConfigured) {
    missing.push("treasury address");
  }

  return missing;
}

function requiredConfigAlias(
  configValue: string | undefined,
  names: string[],
  allowEnvFallback: boolean
) {
  if (configValue) {
    return configValue;
  }
  if (allowEnvFallback) {
    for (const name of names) {
      const value = process.env[name];
      if (value) {
        return value;
      }
    }
  }
  throw new Error(`${names.join(" or ")} is required when CAW_MODE=http.`);
}

function requiredInput(value: string | undefined, name: string) {
  if (!value) {
    throw new Error(`${name} is required for real CAW contract calls.`);
  }
  return value;
}

function getDefaultFaucetTokenId() {
  return process.env.CAW_FAUCET_TOKEN_ID || (process.env.CHAIN_ENV === "base-mainnet" ? "BASE_ETH_USDC" : "BASE_SEPOLIA_USDC");
}

function normalizePactStatus(status: string | undefined): CawPactStatus["status"] {
  if (status === "active") {
    return "active";
  }
  if (status === "expired" || status === "completed") {
    return "expired";
  }
  if (status === "revoked" || status === "rejected") {
    return "revoked";
  }
  return "pending_user_approval";
}

function stringField(source: Record<string, unknown>, key: string, fallback: string) {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}
