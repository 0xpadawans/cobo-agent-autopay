// Venice balance: queries both billing API and x402 wallet API,
// records a snapshot in memory, and exposes a normalized shape for the dashboard.

import { recordBalanceSnapshot } from "@/lib/store/venice";
import { createId, nowIso } from "@/lib/store/memory";
import {
  fetchVeniceBillingBalance,
  fetchVeniceX402Balance,
  VeniceApiError
} from "@/lib/venice/client";
import type { VeniceBalanceSnapshot } from "@/lib/venice/types";

type BillingBalanceResponse = {
  canConsume?: boolean;
  consumptionCurrency?: VeniceBalanceSnapshot["consumptionCurrency"];
  balances?: {
    diem?: number;
    usd?: number;
  };
  diemEpochAllocation?: number;
};

export async function refreshVeniceBalance(input: {
  walletAddress?: string;
  apiKey?: string;
} = {}): Promise<VeniceBalanceSnapshot> {
  const walletAddress = input.walletAddress;

  // Primary: billing API (Bearer key, no SIWE required)
  let canConsume = false;
  let consumptionCurrency: VeniceBalanceSnapshot["consumptionCurrency"] = null;
  let diemBalance = 0;
  let usdBalance = 0;
  let diemEpochAllocation = 0;
  let source: VeniceBalanceSnapshot["source"] = "billing_api";
  let raw: unknown;

  try {
    const billing = await fetchVeniceBillingBalance(input.apiKey) as BillingBalanceResponse;
    canConsume = Boolean(billing.canConsume);
    consumptionCurrency = billing.consumptionCurrency ?? null;
    diemBalance = Number(billing.balances?.diem ?? 0);
    usdBalance = Number(billing.balances?.usd ?? 0);
    diemEpochAllocation = Number(billing.diemEpochAllocation ?? 0);
    raw = billing;
  } catch (error) {
    if (error instanceof VeniceApiError && walletAddress) {
      // Fall back to x402 wallet path (still may 401 due to SIWE, but record attempt)
      source = "x402_wallet";
      const x402 = await fetchVeniceX402Balance(walletAddress);
      const x402Body = x402.raw as { amount?: number; balance?: number; usdBalance?: number; canConsume?: boolean };
      raw = x402.raw;
      // Best-effort extraction; not strict
      usdBalance = Number(x402Body.usdBalance ?? x402Body.balance ?? x402Body.amount ?? 0);
      canConsume = Boolean(x402Body.canConsume);
    } else {
      throw error;
    }
  }

  const snapshot: VeniceBalanceSnapshot = {
    id: createId("vbs"),
    fetchedAt: nowIso(),
    source,
    canConsume,
    consumptionCurrency,
    diemBalance,
    usdBalance,
    diemEpochAllocation,
    walletAddress,
    rawResponse: raw
  };

  recordBalanceSnapshot(snapshot);
  return snapshot;
}
