// app/api/credits/topup/sweep-status/route.ts
// R4.0 — read-only status route. Tells cron tick / dashboard whether the
// R3.4 sweep heartbeat is running, when it last fired, what it last did.
// Does NOT start the heartbeat — heartbeat is started by instrumentation.ts.
// Does NOT require auth — it's a status page, not a state-changing action.

import { getR34SweepHeartbeatStatus } from "@/lib/r34-sweep-heartbeat";
import { ensureR34SweepHeartbeatRunning } from "@/lib/r34-sweep-heartbeat";
import { getTreasuryStatus } from "@/lib/caw/transfer";
import { okJson } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET() {
  // 懒启动: 如果 instrumentation.ts register() 没跑 (dev server 启动期 race
  // / cold start / hot reload 后没重启), 第一次 GET 这个 status 路由
  // 也启动 heartbeat. 适用 cron tick 单次实现不想 kill dev server 的场景.
  ensureR34SweepHeartbeatRunning();

  const heartbeat = getR34SweepHeartbeatStatus();
  const { treasuryStatus, treasuryLastAmount, treasuryLastTransferAt } = getTreasuryStatus();

  return okJson({
    ...heartbeat,
    treasuryStatus,
    treasuryLastAmount,
    treasuryLastTransferAt,
  });
}
