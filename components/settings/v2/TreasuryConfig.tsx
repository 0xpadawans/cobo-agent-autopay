'use client';

import { useEffect, useState, useCallback } from 'react';
import { Save, Loader2 } from 'lucide-react';
import SectionCard from '@/components/dashboard/v2/SectionCard';

type TreasuryConfigData = {
  treasuryApiKeyMasked: string;
  hasTreasuryApiKey: boolean;
  treasuryApiUrl: string;
  treasuryPactId: string;
  treasuryTopupAmount: number;
};

type FormState = {
  apiKey: string;
  apiUrl: string;
  pactId: string;
  topupAmount: number;
};

/**
 * Treasury Agent 配置区块
 *
 * 风格与 VeniceConfig 保持一致：
 * - 使用 SectionCard 白底圆角容器
 * - 标签 + 输入框 + 保存按钮
 * - API Key 输入时显示脱敏值，编辑时清空
 */
export default function TreasuryConfig() {
  const [config, setConfig] = useState<TreasuryConfigData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // 表单状态
  const [form, setForm] = useState<FormState>({
    apiKey: '',
    apiUrl: '',
    pactId: '',
    topupAmount: 20,
  });
  // API Key 编辑模式（显示脱敏值 vs 清空让用户输入）
  const [editingKey, setEditingKey] = useState(false);

  const loadConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/settings/treasury');
      if (res.ok) {
        const data: TreasuryConfigData = await res.json();
        setConfig(data);
        setForm({
          apiKey: data.hasTreasuryApiKey ? data.treasuryApiKeyMasked : '',
          apiUrl: data.treasuryApiUrl,
          pactId: data.treasuryPactId,
          topupAmount: data.treasuryTopupAmount,
        });
        // 如果有 API Key，初始显示脱敏值，不进入编辑模式
        setEditingKey(!data.hasTreasuryApiKey);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  async function handleSave() {
    setSaving(true);
    setMessage(null);
    try {
      const body: Record<string, unknown> = {};
      // API Key: 仅在编辑模式下提交（用户改了才传）
      if (editingKey) {
        body.treasuryApiKey = form.apiKey;
      }
      if (form.apiUrl !== (config?.treasuryApiUrl ?? '')) {
        body.treasuryApiUrl = form.apiUrl;
      }
      if (form.pactId !== (config?.treasuryPactId ?? '')) {
        body.treasuryPactId = form.pactId;
      }
      if (form.topupAmount !== (config?.treasuryTopupAmount ?? 20)) {
        body.treasuryTopupAmount = form.topupAmount;
      }

      // 至少有一个字段才提交
      if (Object.keys(body).length === 0) {
        setMessage({ type: 'error', text: '没有需要保存的变更' });
        return;
      }

      const res = await fetch('/api/settings/treasury', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage({ type: 'error', text: data.error || '保存失败' });
        return;
      }
      setMessage({ type: 'success', text: '✅ Treasury 配置已保存' });
      // 重新加载（获取脱敏后的 API Key）
      await loadConfig();
    } catch (e) {
      setMessage({ type: 'error', text: e instanceof Error ? e.message : '保存失败' });
    } finally {
      setSaving(false);
    }
  }

  const inputCls =
    'w-full rounded border border-gray-300 px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-[#2563EB]';

  return (
    <SectionCard
      title="Treasury Agent 配置"
      subtitle="配置 Treasury 钱包身份，Spending 钱包 USDC 不足时自动互充"
      action={
        <button
          onClick={handleSave}
          disabled={saving || loading}
          className="inline-flex items-center gap-1.5 rounded-lg bg-[#2563EB] px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-[#1D4ED8] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {saving ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Save className="w-3.5 h-3.5" />
          )}
          {saving ? '保存中...' : '保存配置'}
        </button>
      }
      loading={loading}
    >
      <div className="space-y-4">
        {message && (
          <div
            className={`rounded-lg px-3 py-2 text-xs ${
              message.type === 'success'
                ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                : 'bg-red-50 text-red-700 border border-red-200'
            }`}
          >
            {message.text}
          </div>
        )}

        {/* Treasury API Key */}
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">
            Treasury API Key
          </label>
          <div className="flex gap-2">
            <input
              type={editingKey ? 'password' : 'text'}
              value={form.apiKey}
              onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
              onFocus={() => {
                // 点击编辑时清空脱敏值
                if (!editingKey) {
                  setForm((f) => ({ ...f, apiKey: '' }));
                  setEditingKey(true);
                }
              }}
              placeholder={
                editingKey
                  ? '输入 Treasury CAW API Key'
                  : config?.hasTreasuryApiKey
                    ? config.treasuryApiKeyMasked
                    : '未设置'
              }
              className={`${inputCls} flex-1`}
            />
            {!editingKey && config?.hasTreasuryApiKey && (
              <button
                type="button"
                onClick={() => {
                  setEditingKey(true);
                  setForm((f) => ({ ...f, apiKey: '' }));
                }}
                className="text-[11px] text-blue-600 hover:text-blue-700 whitespace-nowrap"
              >
                修改
              </button>
            )}
          </div>
          <p className="text-[10px] text-gray-400 mt-1">
            Treasury CAW 钱包的 API Key，加密存储，仅用于 tx transfer 签名
          </p>
        </div>

        {/* Treasury API URL */}
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">
            Treasury API URL
          </label>
          <input
            type="text"
            value={form.apiUrl}
            onChange={(e) => setForm((f) => ({ ...f, apiUrl: e.target.value }))}
            placeholder="https://api.agenticwallet.cobo.com"
            className={inputCls}
          />
          <p className="text-[10px] text-gray-400 mt-1">
            留空则使用主钱包的 API URL
          </p>
        </div>

        {/* Treasury Pact ID */}
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">
            Treasury Pact ID
          </label>
          <input
            type="text"
            value={form.pactId}
            onChange={(e) => setForm((f) => ({ ...f, pactId: e.target.value }))}
            placeholder="Treasury 钱包创建的 Transfer Pact ID"
            className={inputCls}
          />
        </div>

        {/* 补充金额 */}
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">
            每次补充金额（USDC）
          </label>
          <input
            type="number"
            min={1}
            max={50}
            value={form.topupAmount}
            onChange={(e) =>
              setForm((f) => ({ ...f, topupAmount: Number(e.target.value) || 20 }))
            }
            className={`${inputCls} w-32`}
          />
          <p className="text-[10px] text-gray-400 mt-1">
            最小 1 USDC，最大 50 USDC。默认 20 USDC
          </p>
        </div>
      </div>
    </SectionCard>
  );
}
