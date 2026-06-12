// SIWE (Sign-In-With-Ethereum) wallet-binding header for Venice inference.
// Cobo Agentic Wallet CLI does NOT support personal_sign (EIP-191), so we
// build an EIP-712 typed-data equivalent that carries the same wallet-binding
// semantics (wallet address + domain + nonce + issued-at). Caw signs this
// typed data with `caw tx sign-message --destination-type eip712`.
//
// Header name follows Venice's documentation: `X-Sign-In-With-X`
// (the value is a base64-encoded JSON object describing the typed data +
// the signature, similar to SIWE's compact serialisation).

import { runCawCli } from "@/lib/caw/cli";

const SIWE_DOMAIN = {
  name: "Venice AI",
  version: "1"
};

const SIWE_TYPES = {
  SiweX: [
    { name: "address", type: "address" },
    { name: "domain", type: "string" },
    { name: "uri", type: "string" },
    { name: "nonce", type: "string" },
    { name: "issuedAt", type: "string" },
    { name: "chainId", type: "uint256" }
  ]
} as const;

export type SiweXMessage = {
  address: string;
  domain: string;
  uri: string;
  nonce: string;
  issuedAt: string;
  chainId: number;
};

export type SiweXPayload = {
  // The EIP-712 typed data we asked the wallet to sign
  typedData: {
    domain: typeof SIWE_DOMAIN;
    types: typeof SIWE_TYPES;
    primaryType: "SiweX";
    message: SiweXMessage;
  };
  // The signature returned by caw
  signature: string;
  // caw transaction UUID
  txId: string;
};

function makeNonce(): string {
  // 17-char base36 random — sufficient uniqueness for nonce, no node:crypto needed
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

export function buildSiweXMessage(input: {
  walletAddress: string;
  uri: string;
  chainId: number;
}): SiweXMessage {
  return {
    address: input.walletAddress,
    domain: SIWE_DOMAIN.name,
    uri: input.uri,
    nonce: makeNonce(),
    issuedAt: new Date().toISOString(),
    chainId: input.chainId
  };
}

export function buildSiweXTypedData(message: SiweXMessage): SiweXPayload["typedData"] {
  return {
    domain: SIWE_DOMAIN,
    types: SIWE_TYPES,
    primaryType: "SiweX",
    message
  };
}

/**
 * Sign the SiweX message using caw tx sign-message.
 * Returns the signature + a serialised header value.
 */
export async function signSiweXWithCaw(input: {
  userId: string;
  pactId: string;
  chainId: string; // e.g. "BASE_ETH" or "BASE_SEPOLIA"
  walletAddress: string;
  uri: string;
  chainNumericId: number;
}): Promise<SiweXPayload> {
  const message = buildSiweXMessage({
    walletAddress: input.walletAddress,
    uri: input.uri,
    chainId: input.chainNumericId
  });
  const typedData = buildSiweXTypedData(message);

  const args = [
    "tx",
    "sign-message",
    "--pact-id",
    input.pactId,
    "--chain-id",
    input.chainId,
    "--destination-type",
    "eip712",
    "--eip712-typed-data",
    JSON.stringify(typedData),
    "--request-id",
    `siwex-${Date.now()}-${message.nonce.slice(0, 8)}`,
    "--timeout",
    "60"
  ];

  const result = await runCawCli(input.userId, args);
  if (result.exitCode !== 0) {
    throw new Error(`caw tx sign-message failed (exit ${result.exitCode}): ${result.stderr.slice(0, 500)}`);
  }
  try {
    const json = JSON.parse(result.stdout);
    if (!json.success) {
      throw new Error(`caw tx sign-message returned success=false: ${result.stdout.slice(0, 500)}`);
    }
    const signature: string =
      json.signature ?? json.data?.signature ?? json.result?.signature ?? "";
    const txId: string = json.tx_id ?? json.data?.tx_id ?? json.result?.tx_id ?? "";
    if (!signature) {
      throw new Error(`caw tx sign-message returned no signature field: ${result.stdout.slice(0, 500)}`);
    }
    return { typedData, signature, txId };
  } catch (error) {
    throw new Error(`Failed to parse caw output: ${(error as Error).message}; raw=${result.stdout.slice(0, 300)}`);
  }
}

/**
 * Encode the signed payload as the X-Sign-In-With-X header value.
 * Format: base64url(json({ typedData, signature }))
 */
export function encodeSiweXHeader(payload: SiweXPayload): string {
  const json = JSON.stringify(payload);
  return Buffer.from(json, "utf8").toString("base64url");
}

export function decodeSiweXHeader(headerValue: string): SiweXPayload {
  const json = Buffer.from(headerValue, "base64url").toString("utf8");
  return JSON.parse(json) as SiweXPayload;
}
