'use client';

import { Loader2, RefreshCw, CheckCircle2, XCircle, Ban } from 'lucide-react';

type TreasuryStatus = 'idle' | 'transferring' | 'completed' | 'failed' | null;

interface TreasuryCardProps {
  status: TreasuryStatus;
  lastAmount: number | null;
  lastTransferAt: string | null;
  isLoading?: boolean;
}

function formatTime(iso: string | null): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

/**
 * Treasury 钱包互充状态卡片
 *
 * | status       | 主文字               | 颜色     | icon     |
 * |--------------|---------------------|----------|----------|
 * | null / idle  | 未触发               | gray     | Ban      |
 * | transferring | 补充中...            | yellow   | Loader2  |
 * | completed    | 已补充 N USDC        | green    | CheckCircle2 |
 * | failed       | 补充失败             | red      | XCircle  |
 */
export default function TreasuryCard({
  status,
  lastAmount,
  lastTransferAt,
  isLoading,
}: TreasuryCardProps) {
  const { label, value, iconClass, iconBg, Icon, hint } = (() => {
    if (isLoading) {
      return {
        label: 'Treasury 互充',
        value: '',
        iconClass: 'text-gray-400',
        iconBg: 'bg-gray-100',
        Icon: RefreshCw,
        hint: '加载中...',
      };
    }

    switch (status) {
      case 'transferring':
        return {
          label: 'Treasury 互充',
          value: '补充中...',
          iconClass: 'text-amber-600',
          iconBg: 'bg-amber-50',
          Icon: Loader2,
          hint: lastTransferAt ? `最近：${formatTime(lastTransferAt)}` : '等待触发',
        };
      case 'completed':
        return {
          label: 'Treasury 互充',
          value: `已补充 ${lastAmount ?? '?'} USDC`,
          iconClass: 'text-emerald-600',
          iconBg: 'bg-emerald-50',
          Icon: CheckCircle2,
          hint: lastTransferAt ? `最近：${formatTime(lastTransferAt)}` : '—',
        };
      case 'failed':
        return {
          label: 'Treasury 互充',
          value: '补充失败',
          iconClass: 'text-red-600',
          iconBg: 'bg-red-50',
          Icon: XCircle,
          hint: lastTransferAt ? `最近：${formatTime(lastTransferAt)}` : '—',
        };
      default: // null / idle
        return {
          label: 'Treasury 互充',
          value: '未触发',
          iconClass: 'text-gray-400',
          iconBg: 'bg-gray-50',
          Icon: Ban,
          hint: '',
        };
    }
  })();

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
      <div className="flex items-center gap-3">
        <div className={`${iconBg} p-2.5 rounded-lg flex-shrink-0`}>
          {status === 'transferring' ? (
            <Icon className={`w-5 h-5 animate-spin ${iconClass}`} />
          ) : (
            <Icon className={`w-5 h-5 ${iconClass}`} />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs text-gray-500 font-medium">{label}</p>
          <p className={`text-sm font-semibold mt-0.5 truncate ${iconClass}`} title={value}>
            {value}
          </p>
          {hint && (
            <p className="text-[11px] text-gray-400 mt-0.5 truncate">{hint}</p>
          )}
        </div>
      </div>
    </div>
  );
}
