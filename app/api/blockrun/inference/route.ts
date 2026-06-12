import { NextRequest, NextResponse } from 'next/server';
import { addBlockRunLog } from '@/app/api/blockrun/logs-store';
import { requireCurrentUser } from '@/lib/auth/session';
import type { BlockRunMessage } from '@/lib/blockrun/topup';
import type { BlockRunX402Step } from '@/lib/blockrun/types';

export async function POST(req: NextRequest) {
  const start = Date.now();

  try {
    const user = await requireCurrentUser();
    const body = await req.json();
    const { prompt, model } = body;

    if (!prompt || typeof prompt !== 'string') {
      return NextResponse.json({ error: 'Missing prompt' }, { status: 400 });
    }

    const modelToUse = model || process.env.BLOCKRUN_MODEL || 'openai/gpt-oss-20b';

    try {
      // Import dynamically to avoid server-side modules not found
      const { runBlockRunX402Inference, getBlockRunX402Request, getBlockRunConfigInfo } = await import('@/lib/blockrun/topup');

      // Get pact info from database
      let pactId: string;
      let walletAddress: string;
      try {
        const request = await getBlockRunX402Request(user.id);
        pactId = request.pactId;
        walletAddress = request.walletAddress;
      } catch {
        // No pact found — can still run for test purposes
        pactId = '__no_pact__';
        walletAddress = '0x0000000000000000000000000000000000000000';
      }

      const configInfo = getBlockRunConfigInfo();
      const pactNetwork = configInfo.network;

      const result = await runBlockRunX402Inference({
        userId: user.id,
        walletAddress,
        pactId,
        model: modelToUse,
        messages: [{ role: 'user', content: prompt }] satisfies BlockRunMessage[],
        usdAmount: 0.01,
      });

      const durationMs = Date.now() - start;

      if (result.status === 'completed' && result.responseStatus >= 200 && result.responseStatus < 300) {
        // Try to extract the actual response content
        let resultText = result.responseBody;
        try {
          const parsed = JSON.parse(result.responseBody);
          if (parsed.choices?.[0]?.message?.content) {
            resultText = parsed.choices[0].message.content;
          }
        } catch {
          // Use raw response
        }

        await addBlockRunLog({
          prompt,
          model: modelToUse,
          durationMs,
          costUsdc: 0.001,
          status: 'completed',
        });

        return NextResponse.json({
          ok: true,
          result: resultText,
          costUsdc: 0.001,
          duration: durationMs,
          pactId: pactId === '__no_pact__' ? null : pactId.slice(0, 8) + '...',
          pactNetwork,
          steps: result.steps,
        });
      } else {
        await addBlockRunLog({
          prompt,
          model: modelToUse,
          durationMs,
          costUsdc: null,
          status: 'failed',
        });

        return NextResponse.json({
          ok: false,
          error: result.error || `x402 returned HTTP ${result.responseStatus}`,
          duration: durationMs,
          pactId: pactId === '__no_pact__' ? null : pactId.slice(0, 8) + '...',
          pactNetwork,
          steps: result.steps,
        });
      }
    } catch (e) {
      const durationMs = Date.now() - start;
      await addBlockRunLog({
        prompt,
        model: modelToUse,
        durationMs,
        costUsdc: null,
        status: 'failed',
      });

      return NextResponse.json({
        ok: false,
        error: e instanceof Error ? e.message : 'Inference failed',
        duration: durationMs,
        steps: {
          received402: false,
          signed: null,
          txHash: null,
          gotResult: false,
        } as BlockRunX402Step,
      }, { status: 500 });
    }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
}
