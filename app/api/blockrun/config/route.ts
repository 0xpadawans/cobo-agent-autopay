import { NextRequest, NextResponse } from 'next/server';

// In-memory config store (not persistent, but fine for dev)
const config: {
  model: string;
  useTestnet: boolean;
  minBalance: number;
} = {
  model: process.env.BLOCKRUN_MODEL || 'openai/gpt-oss-20b',
  useTestnet: process.env.BLOCKRUN_USE_TESTNET !== 'false',
  minBalance: Number(process.env.BLOCKRUN_MIN_BALANCE ?? 5),
};

export async function GET() {
  return NextResponse.json({
    configured: true,
    model: config.model,
    useTestnet: config.useTestnet,
    minBalance: config.minBalance,
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (body.model !== undefined) config.model = body.model;
    if (body.useTestnet !== undefined) config.useTestnet = body.useTestnet;
    if (body.minBalance !== undefined) config.minBalance = body.minBalance;
    return NextResponse.json({
      configured: true,
      model: config.model,
      useTestnet: config.useTestnet,
      minBalance: config.minBalance,
    });
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
}
