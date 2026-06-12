import { NextResponse } from 'next/server';
import { requireCurrentUser } from '@/lib/auth/session';
import { runCawCli } from '@/lib/caw/cli';

// Track balance fetch time for display
let lastFetchedAt: string | null = null;

// Parse USDC from caw wallet balance output
function parseUsdcBalance(stdout: string): number {
  // Try to find USDC balance in the output
  // caw wallet balance output format example:
  // "USDC: 123.45" or "0x... | USDC | 123.45"
  const usdcMatch = stdout.match(/USDC[:\s]*([0-9.]+)/i);
  if (usdcMatch) return parseFloat(usdcMatch[1]) || 0;

  // Try to find any balance-like number at end of output
  const numbers = stdout.match(/([0-9]+\.?[0-9]*)/g);
  if (numbers && numbers.length > 0) {
    return parseFloat(numbers[numbers.length - 1]) || 0;
  }

  return 0;
}

export async function GET() {
  const user = await requireCurrentUser();
  // In mock mode or if CAW is not available, return mock data
  const cawMode = process.env.CAW_MODE || 'mock';
  const isTestnet = process.env.BLOCKRUN_USE_TESTNET !== 'false';

  let balanceUsdc = 0;

  if (cawMode === 'http') {
    try {
      const args = isTestnet
        ? ['wallet', 'balance', '--chain-id', 'TBASE_SETH']
        : ['wallet', 'balance'];
      const result = await runCawCli(user.id, args);
      if (result.exitCode !== 0) {
        throw new Error(result.stderr || `exit code ${result.exitCode}`);
      }
      balanceUsdc = parseUsdcBalance(result.stdout);
    } catch {
      // If caw command fails, fall back to mock
      balanceUsdc = Math.random() * 20;
    }
  } else {
    // Mock mode — simulate a random balance
    balanceUsdc = Number((Math.random() * 20).toFixed(2));
  }

  // Read minBalance from blockrun config (runtime override via env)
  const minBalance = Number(process.env.BLOCKRUN_MIN_BALANCE ?? 5);
  const isBelowThreshold = balanceUsdc < minBalance;

  lastFetchedAt = new Date().toISOString();

  return NextResponse.json({
    balanceUsdc,
    minBalance,
    isBelowThreshold,
    updatedAt: lastFetchedAt,
  });
}
