'use client';

import AppLayout from '@/components/layout/AppLayout';
import AgentSelector from '@/components/dashboard/v2/AgentSelector';
import AutoTopupSettings from '@/components/settings/v2/AutoTopupSettings';
import VeniceConfig from '@/components/settings/v2/VeniceConfig';
import CawWalletInfo from '@/components/settings/v2/CawWalletInfo';
import GuardrailsCard from '@/components/settings/v2/GuardrailsCard';
import TreasuryConfig from '@/components/settings/v2/TreasuryConfig';

/**
 * Settings — 按需求文档 §六 重写
 *
 * 区块：
 *  1. 自动充值设置：Venice 余额阈值（GET/POST /api/settings）
 *  2. Venice 配置：API Key / x402 余额 / 充值地址
 *  3. CAW 钱包信息：地址 / 模式 / 配对 / 授权 / 活跃 Pact
 *  4. Guardrails：状态（AI 推荐/系统默认）+ 4 项限额 + 生成 AI 推荐
 *
 * 数据严格来源于后端 API：
 *   /api/settings
 *   /api/venice/balance
 *   /api/wallet/caw/status
 *   /api/wallet/caw/pacts
 *   /api/credits/balance
 *   /api/guardrails/recommend
 */
export default function SettingsPage() {
  return (
    <AppLayout title="设置">
      <div className="space-y-6">
        {/* 顶部 Agent 选择器（多 Agent 预留，静态只读） */}
        <div className="flex items-center justify-between">
          <AgentSelector />
        </div>

        {/* 区块 1：自动充值设置 */}
        <AutoTopupSettings />

        {/* 区块 2 + 区块 3 并排 */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <VeniceConfig />
          <CawWalletInfo />
        </div>

        {/* 区块 4：Guardrails */}
        <GuardrailsCard />

        {/* 区块 5：Treasury 配置 */}
        <TreasuryConfig />
      </div>
    </AppLayout>
  );
}
