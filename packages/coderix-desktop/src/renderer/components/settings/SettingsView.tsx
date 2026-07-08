import React, { useState, useEffect, useCallback } from 'react';
import { useUIStore, type PermissionMode, type Theme } from '../../store/uiStore.js';
import { useSettingsStore, type SettingsData, type ProviderConfig, PROVIDER_CATALOG, getProviderModels, getProviderBaseUrl } from '../../store/settingsStore.js';

// ── Component ──────────────────────────────────────────────

export default function SettingsView({ onClose }: { onClose?: () => void }): React.ReactElement {
  const [showApiKey, setShowApiKey] = useState<Record<string, boolean>>({});
  const [draft, setDraft] = useState<SettingsData | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const { setTheme, setPermissionMode } = useUIStore();
  const { settings, loading, load, save } = useSettingsStore();

  // Reload from file every time settings panel opens
  useEffect(() => { load(); }, [load]);

  // Sync from store to draft whenever store updates (e.g. after load completes)
  useEffect(() => {
    if (settings) setDraft(JSON.parse(JSON.stringify(settings)));
  }, [settings]);

  // ── Draft helpers ────────────────────────────────────────

  const updateDraft = useCallback((patch: Partial<SettingsData> & { providers?: ProviderConfig[] }) => {
    setDraft((d) => d ? { ...d, ...patch } : d);
  }, []);

  const updateProviderInDraft = useCallback((i: number, patch: Partial<ProviderConfig>) => {
    setDraft((d) => {
      if (!d) return d;
      return { ...d, providers: d.providers.map((p, idx) => i === idx ? { ...p, ...patch } : p) };
    });
  }, []);

  const handleSave = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    setSaveMsg('');
    try {
      await save(draft);
      setSaveMsg('已保存');
      setTimeout(() => setSaveMsg(''), 2000);
    } catch (e) {
      setSaveMsg('保存失败: ' + (e as Error).message);
    } finally {
      setSaving(false);
    }
  }, [draft, save]);

  const addProvider = useCallback(() => {
    setDraft((d) => {
      if (!d) return d;
      const firstKey = Object.keys(PROVIDER_CATALOG)[0] ?? 'deepseek';
      const models = getProviderModels(firstKey).map((m) => ({ name: m, temperature: 0.7, maxTokens: 32768 }));
      return {
        ...d,
        providers: [...d.providers, {
          name: firstKey, apiKey: '', baseUrl: getProviderBaseUrl(firstKey),
          models, connected: false,
        }],
      };
    });
  }, []);

  const removeProvider = useCallback((i: number) => {
    setDraft((d) => d ? { ...d, providers: d.providers.filter((_, idx) => idx !== i) } : d);
  }, []);

  const toggleApiKey = useCallback((name: string) => setShowApiKey((s) => ({ ...s, [name]: !s[name] })), []);

  // ── Inline styles ────────────────────────────────────────
  const S = {
    header: { padding: '16px 24px', borderBottom: '1px solid var(--color-separator)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 } as React.CSSProperties,
    body: { flex: 1, overflowY: 'auto', padding: '24px' } as React.CSSProperties,
    card: { padding: '20px', borderRadius: 'var(--radius-lg)', background: 'var(--color-bg-secondary)', border: '1px solid var(--color-separator)', marginBottom: '16px' } as React.CSSProperties,
    cardHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' } as React.CSSProperties,
    badge: (ok: boolean) => ({ fontSize: 'var(--text-xs)', padding: '2px 10px', borderRadius: 'var(--radius-full)', background: ok ? 'var(--color-success)' : 'var(--color-text-tertiary)', color: '#fff', fontWeight: 500 } as React.CSSProperties),
    label: { display: 'block', fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)', marginBottom: '4px', marginTop: '12px' } as React.CSSProperties,
    input: { width: '100%', padding: '8px 12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-separator)', background: 'var(--color-input-bg)', color: 'var(--color-text-primary)', fontSize: 'var(--text-sm)', fontFamily: 'var(--font-mono)', boxSizing: 'border-box' as const } as React.CSSProperties,
    select: { width: '100%', padding: '8px 12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-separator)', background: 'var(--color-input-bg)', color: 'var(--color-text-primary)', fontSize: 'var(--text-sm)', boxSizing: 'border-box' as const } as React.CSSProperties,
    section: { marginTop: '24px' } as React.CSSProperties,
    sectionTitle: { fontSize: 'var(--text-base)', fontWeight: 600, marginBottom: '12px' } as React.CSSProperties,
    themeBtn: (active: boolean, t: Theme) => ({ padding: '12px 24px', borderRadius: 'var(--radius-lg)', border: active ? '2px solid var(--color-brand)' : '1px solid var(--color-separator)', background: t === 'light' ? '#FAF9F5' : '#262624', color: t === 'light' ? '#29261B' : '#EDEBE0', cursor: 'pointer', fontSize: 'var(--text-sm)', fontWeight: active ? 600 : 400, minWidth: '100px', marginRight: '12px' } as React.CSSProperties),
    permBtn: (active: boolean) => ({ textAlign: 'left' as const, padding: '12px 16px', borderRadius: 'var(--radius-lg)', border: active ? '2px solid var(--color-brand)' : '1px solid var(--color-separator)', background: 'var(--color-bg-secondary)', cursor: 'pointer', marginBottom: '8px', width: '100%' }),
    saveBtn: { padding: '6px 16px', borderRadius: 'var(--radius-md)', background: 'var(--color-brand)', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 'var(--text-sm)', fontWeight: 500, opacity: 1 } as React.CSSProperties,
    addBtn: { width: '100%', padding: '12px', borderRadius: 'var(--radius-md)', border: '1px dashed var(--color-separator)', background: 'transparent', color: 'var(--color-text-secondary)', cursor: 'pointer', fontSize: 'var(--text-sm)', marginTop: '8px' } as React.CSSProperties,
  };

  const isLoading = loading || !draft;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--color-bg-primary)', color: 'var(--color-text-primary)' }}>
      {isLoading ? (
        <div style={{ padding: '24px', textAlign: 'center', color: 'var(--color-text-tertiary)' }}>加载设置中...</div>
      ) : (
      <div>
      {/* Header */}
      <div style={S.header}>
        <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: 600, margin: 0 }}>设置</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {saveMsg && <span style={{ fontSize: 'var(--text-xs)', color: saveMsg.includes('失败') ? 'var(--color-danger)' : 'var(--color-success)' }}>{saveMsg}</span>}
          <button onClick={handleSave} disabled={saving} style={{ ...S.saveBtn, opacity: saving ? 0.6 : 1 }}>{saving ? '保存中...' : '保存'}</button>
          {onClose && <button onClick={onClose} style={{ width: '28px', height: '28px', border: 'none', background: 'none', cursor: 'pointer', fontSize: '16px', color: 'var(--color-text-secondary)' }}>✕</button>}
        </div>
      </div>

      {/* Body */}
      <div style={S.body}>
        <h3 style={S.sectionTitle}>模型配置</h3>
        {draft.providers.map((p, i) => (
          <div key={i} style={S.card}>
            <div style={S.cardHeader}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <select
                  value={p.name}
                  onChange={(e) => {
                    const n = e.target.value;
                    updateProviderInDraft(i, { name: n, apiKey: '', models: getProviderModels(n).map(m => ({ name: m, temperature: 0.7, maxTokens: 32768 })), baseUrl: getProviderBaseUrl(n) });
                  }}
                  style={{ border: '1px solid var(--color-separator)', borderRadius: 'var(--radius-md)', padding: '4px 8px', fontSize: 'var(--text-base)', fontWeight: 600, background: 'var(--color-input-bg)', color: 'var(--color-text-primary)' }}
                >
                  {Object.keys(PROVIDER_CATALOG).map(k => <option key={k} value={k}>{k.charAt(0).toUpperCase() + k.slice(1)}</option>)}
                  {!PROVIDER_CATALOG[p.name.toLowerCase()] && <option value={p.name}>{p.name}</option>}
                </select>
                <span style={S.badge(p.connected)}>{p.connected ? '已配置' : '未配置'}</span>
              </span>
              <button onClick={() => removeProvider(i)} style={{ background: 'none', border: 'none', color: 'var(--color-text-tertiary)', cursor: 'pointer', fontSize: '14px' }}>🗑</button>
            </div>

            {/* API Key */}
            <label style={{ ...S.label, marginTop: 0 }}>API Key</label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                type={showApiKey[p.name] ? 'text' : 'password'}
                value={p.apiKey}
                onChange={(e) => updateProviderInDraft(i, { apiKey: e.target.value })}
                placeholder="输入 API Key..."
                style={{ ...S.input, flex: 1 }}
              />
              <button onClick={() => toggleApiKey(p.name)} style={{ padding: '6px 10px', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-separator)', background: 'var(--color-bg-tertiary)', cursor: 'pointer', fontSize: 'var(--text-xs)' }}>{showApiKey[p.name] ? '隐藏' : '显示'}</button>
            </div>

            {/* Base URL */}
            <label style={S.label}>Base URL</label>
            <input type="text" value={p.baseUrl} onChange={(e) => updateProviderInDraft(i, { baseUrl: e.target.value })} style={S.input} />

            {/* Model */}
            <label style={S.label}>模型</label>
            {PROVIDER_CATALOG[p.name.toLowerCase()]?.isRelay ? (
              <div style={{ display: 'flex', gap: '8px' }}>
                <input
                  type="text"
                  value={draft.defaultModel}
                  onChange={(e) => updateDraft({ defaultModel: e.target.value })}
                  placeholder="输入模型名，如 openai/gpt-4.1"
                  style={{ ...S.input, flex: 1 }}
                />
                <select onChange={(e) => { if (e.target.value) updateDraft({ defaultModel: e.target.value }); }} style={{ ...S.select, width: '40px', flexShrink: 0 }} defaultValue="">
                  <option value="" disabled>▼</option>
                  {p.models.map(m => <option key={m.name} value={m.name}>{m.name}</option>)}
                </select>
              </div>
            ) : (
              <select value={draft.defaultModel} onChange={(e) => updateDraft({ defaultModel: e.target.value })} style={S.select}>
                {p.models.map(m => <option key={m.name} value={m.name}>{m.name}</option>)}
              </select>
            )}
          </div>
        ))}
        <button style={S.addBtn} onClick={addProvider}>+ 添加 Provider</button>

        {/* General */}
        <div style={S.section}>
          <h3 style={S.sectionTitle}>外观</h3>
          <div style={{ display: 'flex' }}>
            {(['light', 'dark'] as Theme[]).map(t => (
              <button key={t} onClick={() => { setTheme(t); updateDraft({ theme: t }); }} style={S.themeBtn(draft.theme === t, t)}>{t === 'light' ? '☀ 浅色' : '🌙 深色'}</button>
            ))}
          </div>
        </div>
        <div style={S.section}>
          <h3 style={S.sectionTitle}>权限</h3>
          <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', marginBottom: '12px' }}>控制 Agent 执行工具操作时的默认行为。</p>
          {([
            { mode: 'plan' as PermissionMode, label: '先出计划再执行', desc: 'Agent 先制定计划，您审批后再执行。' },
            { mode: 'ask' as PermissionMode, label: '每次操作前询问', desc: '每个工具调用都需要您确认。' },
            { mode: 'auto' as PermissionMode, label: '自动执行', desc: 'Agent 自动执行所有操作，不询问。推荐。' },
          ]).map(({ mode, label, desc }) => (
            <button key={mode} onClick={() => { setPermissionMode(mode); updateDraft({ defaultPermissionMode: mode }); }} style={S.permBtn(draft.defaultPermissionMode === mode)}>
              <div style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>{label}</div>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)', marginTop: '4px' }}>{desc}</div>
            </button>
          ))}
        </div>
      </div>
      </div>
      )}
    </div>
  );
}

SettingsView.displayName = 'SettingsView';
