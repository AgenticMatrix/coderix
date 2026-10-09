import React, { useState } from 'react';
import {
  Plug,
  Check,
  RefreshCw,
  Trash2,
  ChevronDown,
  ChevronUp,
  Settings2,
} from 'lucide-react';
import type { McpServerStatus, McpTestResult } from '../../ipc-client.js';
import {
  testMcpServer,
  setMcpServerEnabled,
  configureMcpServer,
  removeMcpServer,
} from '../../ipc-client.js';
import { useT } from '../../i18n/index.js';
import { useUIStore } from '../../store/uiStore.js';

/** Clamp description text to two lines. */
const clamp2: React.CSSProperties = {
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
};

export interface LinkerTabProps {
  /** All configured MCP servers with display details (from `mcp:catalog`). */
  servers: McpServerStatus[];
  /** Names enabled for the active session (per-session selection). */
  selected: string[];
  /** Toggle the active session's MCP server selection. */
  onSelectionChange: (next: string[]) => void;
  /** Re-read the catalog after a persistent mutation (enable/remove/configure). */
  onRefresh: () => void | Promise<void>;
}

/**
 * LinkerTab — the 「链接器」 surface. Renders each MCP server as a catalog card
 * (icon, status, description, transport, endpoint, test tools) and layers the
 * per-session selection on top of persistent enable/disable/remove actions.
 */
export function LinkerTab({
  servers,
  selected,
  onSelectionChange,
  onRefresh,
}: LinkerTabProps): React.ReactElement {
  const t = useT();
  const lang = useUIStore((s) => s.language);
  const pick = (zh: string, en: string) => (lang === 'en' ? en : zh);

  const [testing, setTesting] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<Record<string, McpTestResult | undefined>>({});
  const [openTools, setOpenTools] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [configuring, setConfiguring] = useState<McpServerStatus | null>(null);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});

  const selectedSet = new Set(selected);

  const toggleSession = (name: string) => {
    const next = selectedSet.has(name)
      ? selected.filter((s) => s !== name)
      : [...selected, name];
    onSelectionChange(next);
  };

  const markBusy = (name: string, on: boolean) =>
    setBusy((prev) => {
      const set = new Set(prev);
      if (on) set.add(name);
      else set.delete(name);
      return set;
    });

  const handleTest = async (s: McpServerStatus) => {
    setTesting((prev) => new Set(prev).add(s.name));
    setResults((prev) => ({ ...prev, [s.name]: undefined }));
    try {
      const result = await testMcpServer(s.name);
      setResults((prev) => ({ ...prev, [s.name]: result }));
      if (result.ok && result.tools) {
        setOpenTools((prev) => new Set(prev).add(s.name));
      }
    } catch (e) {
      setResults((prev) => ({ ...prev, [s.name]: { ok: false, error: String(e) } }));
    } finally {
      setTesting((prev) => {
        const set = new Set(prev);
        set.delete(s.name);
        return set;
      });
    }
  };

  const handleToggleEnabled = async (s: McpServerStatus) => {
    markBusy(s.name, true);
    try {
      await setMcpServerEnabled(s.name, Boolean(s.disabled));
      await onRefresh();
    } finally {
      markBusy(s.name, false);
    }
  };

  const handleRemove = async (s: McpServerStatus) => {
    markBusy(s.name, true);
    try {
      await removeMcpServer(s.name);
      setResults((prev) => ({ ...prev, [s.name]: undefined }));
      await onRefresh();
    } finally {
      markBusy(s.name, false);
    }
  };

  const handleConnect = async (s: McpServerStatus) => {
    // Restoring a removed server, or enabling one whose credentials are missing.
    if (needsConfig(s)) {
      openConfig(s);
      return;
    }
    markBusy(s.name, true);
    try {
      await setMcpServerEnabled(s.name, true);
      await onRefresh();
    } finally {
      markBusy(s.name, false);
    }
  };

  const openConfig = (s: McpServerStatus) => {
    setFieldValues({});
    setConfiguring(s);
  };

  const handleSaveConfig = async () => {
    if (!configuring) return;
    const secretValues: Record<string, string> = {};
    for (const key of configuring.secretEnv ?? []) {
      const value = fieldValues[key];
      if (value) secretValues[key] = value;
    }
    const argValues: Record<string, string> = {};
    for (const field of configuring.meta?.fields ?? []) {
      if (field.argIndex === undefined) continue;
      const value = fieldValues[field.key];
      if (value) argValues[String(field.argIndex)] = value;
    }
    const name = configuring.name;
    setConfiguring(null);
    markBusy(name, true);
    try {
      await configureMcpServer(name, { secrets: secretValues, args: argValues });
      await setMcpServerEnabled(name, true);
      await onRefresh();
    } finally {
      markBusy(name, false);
    }
  };

  const toggleTools = (name: string) =>
    setOpenTools((prev) => {
      const set = new Set(prev);
      if (set.has(name)) set.delete(name);
      else set.add(name);
      return set;
    });

  const needsConfig = (s: McpServerStatus): boolean =>
    (s.secretEnv?.length ?? 0) > 0 && !s.secretsSet;

  const pathFields = (configuring?.meta?.fields ?? []).filter((f) => f.argIndex !== undefined);
  const secretFields = configuring?.secretEnv ?? [];

  if (servers.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-20 text-[var(--color-text-tertiary)]">
        <Plug size={40} className="opacity-30" />
        <span className="text-sm">{t('plugins.empty')}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="mb-1">
        <p className="text-sm text-[var(--color-text-secondary)]">{t('plugins.mcpSubtitle')}</p>
        <p className="mt-1 text-xs text-[var(--color-text-tertiary)]">{t('plugins.mcpActivateHint')}</p>
      </div>

      <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(300px,1fr))]">
        {servers.map((s) => {
          const result = results[s.name];
          const isTesting = testing.has(s.name);
          const isBusy = busy.has(s.name);
          const toolsOpen = openTools.has(s.name);
          const isRemote = s.transport === 'http' || s.transport === 'sse';
          const inSession = selectedSet.has(s.name);
          const status = statusBadge(s, t);

          return (
            <div
              key={s.name}
              className="flex flex-col rounded-[var(--radius-lg)] border border-[var(--color-separator)] bg-[var(--color-bg-secondary)] p-4 transition-shadow hover:shadow-md"
            >
              <div className="flex items-center gap-3 mb-2">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-brand-muted)] text-2xl">
                  {s.meta?.icon ?? '🔌'}
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="truncate text-sm font-semibold text-[var(--color-text-primary)]">
                    {s.meta ? pick(s.meta.nameZh, s.meta.nameEn) : s.name}
                  </h3>
                  <span
                    className={`mt-0.5 inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${status.className}`}
                  >
                    {status.label}
                  </span>
                </div>
                {inSession && (
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--color-brand)] text-white">
                    <Check size={12} strokeWidth={3} />
                  </span>
                )}
              </div>

              <p className="mb-2 text-xs leading-snug text-[var(--color-text-secondary)]" style={clamp2}>
                {s.meta ? pick(s.meta.descriptionZh, s.meta.descriptionEn) : s.scope}
              </p>

              <div className="mb-2 flex flex-wrap gap-1">
                <span className="rounded-full bg-[var(--color-bg-tertiary)] px-2 py-0.5 text-[11px] text-[var(--color-text-secondary)]">
                  {isRemote ? t('plugins.mcpRemote') : 'stdio'}
                </span>
                {s.meta?.credential && (
                  <span className="rounded-full bg-[var(--color-bg-tertiary)] px-2 py-0.5 text-[11px] text-[var(--color-text-secondary)]">
                    {s.meta.credential}
                  </span>
                )}
                {s.toolCount > 0 && (
                  <span className="rounded-full bg-[var(--color-bg-tertiary)] px-2 py-0.5 text-[11px] text-[var(--color-text-secondary)]">
                    {t('plugins.mcpToolsN', { n: s.toolCount })}
                  </span>
                )}
              </div>

              {s.endpoint && (
                <p
                  className="mb-3 truncate rounded bg-[var(--color-bg-tertiary)] px-2 py-1 font-mono text-[11px] text-[var(--color-text-tertiary)]"
                  title={s.endpoint}
                >
                  {s.endpoint}
                </p>
              )}

              {result && (
                <div className="mb-3">
                  {result.ok ? (
                    <div className="rounded-[var(--radius-md)] border border-[var(--color-separator)]">
                      <button
                        type="button"
                        onClick={() => toggleTools(s.name)}
                        className="flex w-full items-center justify-between px-2 py-1.5 text-xs font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)]"
                      >
                        <span className="flex items-center gap-1.5">
                          <Check size={13} className="text-[var(--color-success)]" />
                          {result.tools && result.tools.length > 0
                            ? t('plugins.mcpToolsN', { n: result.tools.length })
                            : t('plugins.mcpNoTools')}
                        </span>
                        {toolsOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                      </button>
                      {toolsOpen && result.tools && result.tools.length > 0 && (
                        <div className="max-h-48 overflow-auto border-t border-[var(--color-separator)] p-2">
                          {result.tools.map((tool) => (
                            <div key={tool.name} className="py-1">
                              <div className="font-mono text-[11px] text-[var(--color-text-primary)]">
                                {tool.name}
                              </div>
                              {tool.description && (
                                <div className="text-[11px] text-[var(--color-text-tertiary)]" style={clamp2}>
                                  {tool.description}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="rounded-[var(--radius-md)] bg-[var(--color-danger-muted)] px-2 py-1.5 text-xs text-[var(--color-danger)]">
                      {t('plugins.mcpTestFailed')}
                      {result.error ? `: ${result.error}` : ''}
                    </div>
                  )}
                </div>
              )}

              <div className="mt-auto flex flex-wrap items-center gap-2">
                {!s.removed && (
                  <button
                    type="button"
                    onClick={() => toggleSession(s.name)}
                    className={`flex items-center gap-1.5 rounded-[var(--radius-md)] border px-3 py-1.5 text-xs transition-colors ${
                      inSession
                        ? 'border-[var(--color-brand)] bg-[var(--color-brand-muted)] text-[var(--color-brand)]'
                        : 'border-[var(--color-separator)] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)]'
                    }`}
                  >
                    <span
                      className={`flex h-3.5 w-3.5 items-center justify-center rounded border ${
                        inSession
                          ? 'border-[var(--color-brand)] bg-[var(--color-brand)] text-white'
                          : 'border-[var(--color-separator)] text-transparent'
                      }`}
                    >
                      <Check size={10} strokeWidth={3} />
                    </span>
                    {t('plugins.mcpSessionToggle')}
                  </button>
                )}

                {s.removed ? (
                  <button
                    type="button"
                    onClick={() => handleConnect(s)}
                    disabled={isBusy}
                    className="flex items-center gap-1.5 rounded-[var(--radius-md)] bg-[var(--color-brand)] px-3 py-1.5 text-xs text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                  >
                    <Plug size={13} />
                    {t('plugins.mcpConnect')}
                  </button>
                ) : (
                  <>
                    {needsConfig(s) ? (
                      <button
                        type="button"
                        onClick={() => openConfig(s)}
                        className="flex items-center gap-1.5 rounded-[var(--radius-md)] bg-[var(--color-brand)] px-3 py-1.5 text-xs text-white transition-opacity hover:opacity-90"
                      >
                        <Plug size={13} />
                        {t('plugins.mcpConnect')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleToggleEnabled(s)}
                        disabled={isBusy}
                        className="rounded-[var(--radius-md)] border border-[var(--color-separator)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-bg-tertiary)] disabled:opacity-50"
                      >
                        {s.disabled ? t('plugins.mcpEnable') : t('plugins.mcpDisable')}
                      </button>
                    )}

                    {(s.secretEnv?.length ?? 0) > 0 || (s.meta?.fields?.length ?? 0) > 0 ? (
                      <button
                        type="button"
                        onClick={() => openConfig(s)}
                        title={t('plugins.mcpConfigure')}
                        className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-md)] border border-[var(--color-separator)] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-tertiary)]"
                      >
                        <Settings2 size={14} />
                      </button>
                    ) : null}

                    <button
                      type="button"
                      onClick={() => handleTest(s)}
                      disabled={isTesting}
                      className="flex items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-separator)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-bg-tertiary)] disabled:opacity-50"
                    >
                      {isTesting ? <RefreshCw size={13} className="animate-spin" /> : <Plug size={13} />}
                      {isTesting ? t('plugins.mcpTesting') : t('plugins.mcpTest')}
                    </button>

                    <button
                      type="button"
                      onClick={() => handleRemove(s)}
                      disabled={isBusy}
                      title={t('plugins.mcpRemove')}
                      className="ml-auto flex h-7 w-7 items-center justify-center rounded-[var(--radius-md)] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-danger-muted)] hover:text-[var(--color-danger)] disabled:opacity-50"
                    >
                      <Trash2 size={14} />
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Configuration dialog */}
      {configuring && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => setConfiguring(null)}
        >
          <div
            className="w-full max-w-md rounded-[var(--radius-lg)] border border-[var(--color-separator)] bg-[var(--color-bg-primary)] p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-base font-semibold text-[var(--color-text-primary)]">
                {t('plugins.mcpConfigureTitle', {
                  name: configuring.meta
                    ? pick(configuring.meta.nameZh, configuring.meta.nameEn)
                    : configuring.name,
                })}
              </h3>
              <button
                type="button"
                onClick={() => setConfiguring(null)}
                className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-md)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]"
              >
                ✕
              </button>
            </div>

            {pathFields.map((f) => (
              <div key={f.key} className="mb-4">
                <label className="mb-1.5 block text-xs font-medium text-[var(--color-text-secondary)]">
                  {pick(f.labelZh, f.labelEn)}
                </label>
                <input
                  type="text"
                  value={fieldValues[f.key] ?? ''}
                  onChange={(e) => setFieldValues((prev) => ({ ...prev, [f.key]: e.target.value }))}
                  placeholder={f.placeholder ?? ''}
                  className="w-full rounded-[var(--radius-md)] border border-[var(--color-separator)] bg-[var(--color-bg-secondary)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:outline-none focus:border-[var(--color-brand)]"
                />
              </div>
            ))}

            {secretFields.map((key) => (
              <div key={key} className="mb-4">
                <label className="mb-1.5 block text-xs font-medium text-[var(--color-text-secondary)]">
                  {key}
                </label>
                <input
                  type="password"
                  value={fieldValues[key] ?? ''}
                  onChange={(e) => setFieldValues((prev) => ({ ...prev, [key]: e.target.value }))}
                  autoComplete="off"
                  className="w-full rounded-[var(--radius-md)] border border-[var(--color-separator)] bg-[var(--color-bg-secondary)] px-3 py-2 text-sm text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-brand)]"
                />
              </div>
            ))}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfiguring(null)}
                className="rounded-[var(--radius-md)] border border-[var(--color-separator)] px-4 py-2 text-sm text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-tertiary)]"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={handleSaveConfig}
                className="rounded-[var(--radius-md)] bg-[var(--color-brand)] px-4 py-2 text-sm text-white transition-opacity hover:opacity-90"
              >
                {t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

LinkerTab.displayName = 'LinkerTab';

/** Status pill for a card, mapping connection state / disabled / removed. */
function statusBadge(
  s: McpServerStatus,
  t: ReturnType<typeof useT>,
): { label: string; className: string } {
  const ok = 'bg-[var(--color-success-muted)] text-[var(--color-success)]';
  const muted = 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]';
  const danger = 'bg-[var(--color-danger-muted)] text-[var(--color-danger)]';

  if (s.removed) return { label: t('plugins.mcpRemoved'), className: muted };
  switch (s.status) {
    case 'connected':
      return { label: t('plugins.mcpStatusConnected'), className: ok };
    case 'disabled':
      return { label: t('plugins.mcpDisabled'), className: muted };
    case 'failed':
      return { label: t('plugins.mcpStatusFailed'), className: danger };
    case 'needs-auth':
      return { label: t('plugins.mcpStatusNeedsAuth'), className: danger };
    case 'pending':
      return { label: t('plugins.mcpStatusPending'), className: muted };
    default:
      return { label: t('plugins.mcpStatusUnconnected'), className: muted };
  }
}
