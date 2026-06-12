#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * x402 + CAW Payment Client
 *
 * Flow:
 *   1. Request resource → HTTP 402 with payment requirements
 *   2. Parse payment requirements
 *   3. Execute payment via CAW (caw tx transfer)
 *   4. Retry request with x-payment-proof header
 *   5. Receive paid resource
 */

const RESOURCE_URL = process.argv[2] || "http://localhost:3000/api/x402/resource";
const { execSync } = require("child_process");
const fs = require("fs");

const DISABLE_TLS = String.fromCharCode(48); // "0"

function readCredentials() {
  const credPath =
    process.env.CAW_CREDENTIALS_PATH ||
    `${process.env.HOME}/.cobo-agentic-wallet/profiles/profile_caw_agent_df4b1aea2757e336/credentials`;
  return JSON.parse(fs.readFileSync(credPath, "utf8"));
}

function cawCli(args, cred) {
  const cmd = `caw ${args} --api-url "${cred.api_url}" --api-key "${cred.api_key}" --timeout 15 2>&1`;
  return execSync(cmd, {
    encoding: "utf8",
    timeout: 20000,
    env: {
      ...process.env,
      PATH: `${process.env.HOME}/.cobo-agentic-wallet/bin:${process.env.PATH}`,
      NODE_TLS_REJECT_UNAUTHORIZED: DISABLE_TLS,
    },
  });
}

async function main() {
  console.log("=== x402 + CAW Payment Demo ===\n");

  // Step 1: Request resource (expect 402)
  console.log(`[1] Requesting ${RESOURCE_URL} ...`);
  const res1 = await fetch(RESOURCE_URL);
  const body1 = await res1.json();

  if (res1.status !== 402) {
    console.log(`Unexpected status ${res1.status}. Response:`, JSON.stringify(body1, null, 2));
    return;
  }

  // Parse payment requirements
  const reqs = body1.paymentRequirements || body1.paymentRequired || body1;
  const accept = Array.isArray(reqs.accepts) ? reqs.accepts[0] : reqs;
  const payTo = accept.payTo || accept.pay_to;
  const amountMinor = accept.amountUsdcMinor || accept.amount;
  const network = accept.network || reqs.network || "unknown";
  const asset = accept.asset || "ETH";

  console.log(`[1] Got HTTP 402 — Payment Required`);
  console.log(`    Pay to: ${payTo}`);
  console.log(`    Amount: ${amountMinor} (${asset})`);
  console.log(`    Network: ${network}`);
  console.log(`    Request ID: ${reqs.requestId || "none"}\n`);

  // For SETH transfer, convert USDC minor to SETH amount
  // 1000000 USDC minor = 1 USDC ≈ use 0.001 SETH as equivalent
  const isSethTransfer = asset === "ETH" || asset === "SETH" || network.includes("Sepolia");
  const transferAmount = isSethTransfer ? "0.001" : String(amountMinor);
  const tokenId = isSethTransfer ? "SETH" : "SETH_USDC";
  const chainId = isSethTransfer ? "SETH" : "SETH";

  // Step 2: Execute CAW payment
  const cred = readCredentials();
  const requestId = `x402-${Date.now()}`;

  console.log(`[2] Executing CAW transfer: ${transferAmount} ${tokenId} → ${payTo} ...`);

  // Get active pact
  let pactId;
  try {
    const pactList = cawCli(`pact list --status active`, cred);
    const pacts = JSON.parse(pactList).result.pacts;
    if (pacts.length === 0) {
      console.log("[!] No active pact found. Create a transfer pact first.");
      return;
    }
    // Prefer x402 pact
    const x402Pact = pacts.find((p) => p.name && p.name.toLowerCase().includes("x402"));
    pactId = x402Pact ? x402Pact.id : pacts[0].id;
    console.log(`    Using pact: ${pactId} (${x402Pact ? x402Pact.name : pacts[0].name})`);
  } catch (e) {
    console.log("[!] Failed to list pacts:", e.message);
    return;
  }

  const srcAddress = "0x916ea4051f2c1815d286bd5c499756d68affeea5";

  // Execute transfer
  let txResult;
  try {
    const raw = cawCli(
      `tx transfer --pact-id ${pactId} --token-id ${tokenId} --chain-id ${chainId} ` +
      `--src-address ${srcAddress} --dst-address ${payTo} --amount ${transferAmount} ` +
      `--request-id ${requestId} --description "x402 payment"`,
      cred
    );
    txResult = JSON.parse(raw);
    console.log(`    Tx submitted: ${txResult.id} (status: ${txResult.status})`);
  } catch (e) {
    console.log("[!] Transfer failed:", e.message);
    return;
  }

  // Wait for confirmation
  const txId = txResult.id;
  let txHash = txResult.transaction_hash;
  let status = txResult.status;

  if (!txHash || status === "Processing") {
    console.log(`    Waiting for confirmation...`);
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const raw = cawCli(`tx get --tx-id ${txId}`, cred);
        const tx = JSON.parse(raw);
        status = tx.status || (tx.result && tx.result.status);
        txHash = tx.transaction_hash || (tx.result && tx.result.transaction_hash);
        console.log(`    [${i + 1}] status=${status} hash=${txHash ? txHash.slice(0, 16) : "pending"}...`);
        if (status === "Success" || status === "Completed" || status === "Failed") break;
      } catch (e) {
        console.log(`    [${i + 1}] poll error: ${e.message}`);
      }
    }
  }

  if (!txHash || (status !== "Success" && status !== "Completed")) {
    console.log(`[!] Payment not confirmed. Status: ${status}`);
    return;
  }

  console.log(`    Payment confirmed! TxHash: ${txHash}\n`);

  // Step 3: Retry with payment proof
  console.log(`[3] Retrying with x-payment-proof header ...`);
  const res2 = await fetch(RESOURCE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-payment-proof": txHash,
    },
    body: JSON.stringify({}),
  });
  const body2 = await res2.json();

  if (res2.status === 200) {
    console.log(`[3] Got HTTP 200 — Resource unlocked!\n`);
    console.log("=== Paid Resource ===");
    console.log(JSON.stringify(body2, null, 2));
    console.log("\n=== x402 Flow Complete! ===");
  } else {
    console.log(`[3] Got HTTP ${res2.status}`);
    console.log(JSON.stringify(body2, null, 2));
  }
}

main().catch(console.error);
