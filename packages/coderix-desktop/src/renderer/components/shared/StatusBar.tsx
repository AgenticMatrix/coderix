import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, ArrowUp, ArrowDown, Database, GitBranch, Command, Terminal, Gauge, Timer, Sun, Moon, Settings } from 'lucide-react';
import { Badge, type BadgeProps } from './Badge';
import { StatPill, type StatRow } from './StatPill';
import { useT, formatRelativeTime, type TranslationKey } from '../../i18n/index.js';
import { useUIStore } from '../../store/uiStore';
import {
  cacheHitPercent,
  formatCompactTokens,
  formatExactTokens,
  formatStatDuration,
  totalBillableTokens,
} from './status-stats';
import './StatusBar.css';

export interface StatusBarProps {
  /** Current agent engine id (e.g. "coderix" / "claude-code") */
  engine?: string;
  /** Tokens used */
  inputTokens?: number;
  outputTokens?: number;
  /** Cache-read tokens accumulated across the session (billed at the cache rate) */
  cacheReadTokens?: number;
  /** Cache-write tokens accumulated across the session */
  cacheWriteTokens?: number;
  /** Current context footprint in tokens (last turn's input + output + cache-read) */
  contextTokens?: number;
  /** Maximum context window size in tokens */
  contextMax?: number;
  /** Session start timestamp (ms epoch) — first message or session creation. */
  sessionStartedAt?: number;
  /** Timestamp of the newest message (ms epoch). */
  lastActiveAt?: number;
  /** Conversation turns (user messages). */
  turnCount?: number;
  /** Model steps (assistant messages). */
  stepCount?: number;
  /** Tool calls across the session. */
  toolCallCount?: number;
  /** Cost */
  cost?: number;
  /** Currency code for the cost (e.g. "USD", "CNY", "EUR"). */
  currency?: string;
  /** Git branch */
  gitBranch?: string;
  /** Git ahead/behind counts */
  gitAhead?: number;
  gitBehind?: number;
  /** Agent status */
  agentStatus?: 'idle' | 'thinking' | 'executing' | 'output' | 'waiting' | 'error';
  /** Whether the terminal panel is open */
  terminalOpen?: boolean;
  /** Toggle the terminal panel */
  onToggleTerminal?: () => void;
  /** Open the settings modal */
  onOpenSettings?: () => void;
  /** Width of the left sidebar column. When > 0, theme + settings render in a
   *  fixed-width leading slot so the engine/status items stay clear of the
   *  sidebar (mirrors the header's sidebar/chat split). */
  leadingWidth?: number;
  /** Additional CSS classes */
  className?: string;
}

function currencySymbol(currency?: string): string {
  switch ((currency ?? 'USD').toUpperCase()) {
    case 'USD': return '$';
    case 'CNY': return '¥';
    case 'EUR': return '€';
    case 'GBP': return '£';
    case 'JPY': return '¥';
    case 'KRW': return '₩';
    default: return '$';
  }
}

function formatCost(cost: number, currency?: string): string {
  const sym = currencySymbol(currency);
  if (cost >= 0.01) return `${sym}${cost.toFixed(2)}`;
  return `<${sym}0.01`;
}

/** Full precision (up to 4 decimals) for the cost row in the detail dialog. */
function formatCostPrecise(cost: number, currency?: string): string {
  const sym = currencySymbol(currency);
  const fixed = cost.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return `${sym}${fixed || '0'}`;
}

const statusConfig: Record<NonNullable<StatusBarProps['agentStatus']>, { labelKey: TranslationKey; variant: NonNullable<BadgeProps['variant']> }> = {
  idle: { labelKey: 'status.idle', variant: 'success' },
  thinking: { labelKey: 'status.thinking', variant: 'purple' },
  executing: { labelKey: 'status.executing', variant: 'warning' },
  output: { labelKey: 'status.output', variant: 'blue' },
  waiting: { labelKey: 'status.waiting', variant: 'warning' },
  error: { labelKey: 'status.error', variant: 'danger' },
};

const ENGINE_LABELS: Record<string, string> = {
  coderix: 'Coderix',
  'claude-code': 'Claude Code',
};

export function StatusBar({
  engine,
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheWriteTokens,
  contextTokens: contextFootprint,
  contextMax,
  sessionStartedAt,
  lastActiveAt,
  turnCount = 0,
  stepCount = 0,
  toolCallCount = 0,
  cost,
  currency,
  gitBranch,
  gitAhead = 0,
  gitBehind = 0,
  agentStatus = 'idle',
  terminalOpen = false,
  onToggleTerminal,
  onOpenSettings,
  leadingWidth = 0,
  className = '',
}: StatusBarProps): React.ReactElement {
  const t = useT();
  const theme = useUIStore((s) => s.theme);
  const setTheme = useUIStore((s) => s.setTheme);
  const status = statusConfig[agentStatus];

  const toggleTheme = () => setTheme(theme === 'light' ? 'dark' : 'light');

  // Context footprint mirrors the CLI: input + output + cache-read tokens for
  // the *current* turn. This is the only correct "context" number. The
  // accumulated input/output/cache-read counters are session totals (see the
  // token dialog) and must NOT be summed into the context gauge — the
  // accumulated cache-read alone reaches tens of millions of tokens.
  const contextTokens = contextFootprint ?? 0;
  const contextRatio = contextMax && contextMax > 0 ? contextTokens / contextMax : 0;
  const contextPercent = Math.min(100, Math.round(contextRatio * 100));
  const contextColor = contextRatio > 0.9
    ? 'var(--color-danger)'
    : contextRatio > 0.7
      ? 'var(--color-warning)'
      : 'var(--color-success)';

  // One exclusive slot for both detail dialogs: opening either closes the other.
  const [openStat, setOpenStat] = useState<'session' | 'usage' | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // Both pills share this container so clicking one counts as "inside" for the
  // other's outside-close check, letting a single click switch dialogs.
  const statsRef = useRef<HTMLDivElement | null>(null);

  // Tick only while the session dialog is open — the bar must stay static
  // between renders, otherwise it would repaint once per second while idle.
  useEffect(() => {
    if (openStat !== 'session') return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [openStat]);

  const toggleStat = useCallback((name: 'session' | 'usage') => {
    setOpenStat((current) => (current === name ? null : name));
  }, []);
  const closeStat = useCallback(() => setOpenStat(null), []);

  const hasTokenUsage =
    inputTokens !== undefined ||
    outputTokens !== undefined ||
    cacheReadTokens !== undefined ||
    cacheWriteTokens !== undefined;

  const usage = {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cacheReadTokens: cacheReadTokens ?? 0,
    cacheWriteTokens: cacheWriteTokens ?? 0,
    totalCost: cost ?? 0,
    currency: currency ?? 'USD',
    contextTokens,
  };
  const totalTokens = totalBillableTokens(usage);
  const cacheRate = cacheHitPercent(usage);
  const hasSessionStats = turnCount > 0 || stepCount > 0;

  const sessionRows: StatRow[] = [];
  if (sessionStartedAt !== undefined) {
    sessionRows.push({
      label: t('status.sessionDuration'),
      value: formatStatDuration((now - sessionStartedAt) / 1000),
    });
  }
  sessionRows.push(
    { label: t('status.turns'), value: String(turnCount) },
    { label: t('status.steps'), value: String(stepCount) },
    { label: t('status.toolCalls'), value: String(toolCallCount) },
  );
  if (turnCount > 0) {
    sessionRows.push({
      label: t('status.avgOutput'),
      value: formatCompactTokens(usage.outputTokens / turnCount),
    });
  }
  if (lastActiveAt !== undefined) {
    sessionRows.push({
      label: t('status.lastActive'),
      value: formatRelativeTime(lastActiveAt),
    });
  }

  const usageRows: StatRow[] = [
    { label: t('status.totalTokens'), value: formatExactTokens(totalTokens) },
    // Always render the rate so the metric never disappears from the dialog —
    // a session whose provider reports no prompt buckets shows "—" instead.
    { label: t('status.cacheHitRate'), value: cacheRate !== null ? `${cacheRate}%` : '—' },
  ];
  usageRows.push(
    { label: t('status.uncachedInput'), value: formatExactTokens(usage.inputTokens) },
    { label: t('status.cacheReadDetail'), value: formatExactTokens(usage.cacheReadTokens) },
    { label: t('status.cacheWritten'), value: formatExactTokens(usage.cacheWriteTokens) },
    { label: t('status.outputDetail'), value: formatExactTokens(usage.outputTokens) },
  );
  if (contextMax !== undefined && contextMax > 0) {
    usageRows.push({
      label: t('status.contextDetail'),
      value: `${formatCompactTokens(contextTokens)}/${formatCompactTokens(contextMax)}`,
    });
  }
  if (cost !== undefined) {
    usageRows.push({
      label: t('status.costDetail'),
      value: formatCostPrecise(cost, currency),
    });
  }

  const leading = (
    <>
      {/* Theme toggle */}
      <button
        type="button"
        onClick={toggleTheme}
        className="inline-flex items-center gap-1 transition-colors cursor-pointer text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]"
        title={theme === 'light' ? t('nav.switchToDark') : t('nav.switchToLight')}
        aria-label={theme === 'light' ? t('nav.darkMode') : t('nav.lightMode')}
      >
        {theme === 'light' ? <Sun size={12} /> : <Moon size={12} />}
      </button>

      {/* Settings */}
      {onOpenSettings && (
        <button
          type="button"
          onClick={onOpenSettings}
          className="inline-flex items-center gap-1 transition-colors cursor-pointer text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]"
          title={t('nav.settings')}
          aria-label={t('nav.settings')}
        >
          <Settings size={12} />
        </button>
      )}
    </>
  );

  return (
    <div
      className={`
        h-8 flex items-stretch
        bg-[var(--color-bg-secondary)] border-t border-[var(--color-separator)]
        select-none font-sans text-[var(--color-text-secondary)]
        ${className}
      `}
    >
      {/* Leading slot — theme + settings, pinned to the sidebar's width so the
          engine/status items below stay clear of the sidebar. */}
      {leadingWidth > 0 && (
        <div
          className="flex-shrink-0 h-full flex items-center px-4 gap-4 text-xs border-r border-[var(--color-separator)]"
          style={{ width: leadingWidth }}
        >
          {leading}
        </div>
      )}

      <div className="flex-1 flex items-center px-4 gap-4 text-xs min-w-0">
        {leadingWidth === 0 && leading}
        {leadingWidth === 0 && <div className="w-px h-3 bg-[var(--color-separator)]" />}

        {/* Engine */}
      {engine && (
        <>
          <span className="inline-flex items-center gap-1 text-[var(--color-text-secondary)]" title={t('status.engine')}>
            <Bot size={12} className="text-[var(--color-text-tertiary)]" />
            <span className="font-medium">{ENGINE_LABELS[engine] ?? engine}</span>
          </span>
          <div className="w-px h-3 bg-[var(--color-separator)]" />
        </>
      )}

      {/* Session + token statistics — click either pill for the full breakdown */}
      {(hasSessionStats || hasTokenUsage) && (
        <>
          <div ref={statsRef} className="flex items-center gap-3">
            {hasSessionStats && (
              <StatPill
                groupRef={statsRef}
                icon={<Timer size={10} className="text-[var(--color-text-tertiary)]" />}
                label={t('status.sessionSummary', { turns: turnCount, steps: stepCount })}
                title={t('status.sessionStats')}
                rows={sessionRows}
                open={openStat === 'session'}
                onToggle={() => toggleStat('session')}
                onClose={closeStat}
                buttonTitle={t('status.openDetails')}
              />
            )}
            {hasTokenUsage && (
              <StatPill
                groupRef={statsRef}
                icon={<Database size={10} className="text-[var(--color-text-tertiary)]" />}
                label={cacheRate !== null
                  ? t('status.tokenSummaryCached', {
                      total: formatCompactTokens(totalTokens),
                      pct: cacheRate,
                    })
                  : formatCompactTokens(totalTokens)}
                title={t('status.tokenUsage')}
                summary={formatExactTokens(totalTokens)}
                rows={usageRows}
                open={openStat === 'usage'}
                onToggle={() => toggleStat('usage')}
                onClose={closeStat}
                buttonTitle={t('status.openDetails')}
              />
            )}
          </div>
          <div className="w-px h-3 bg-[var(--color-separator)]" />
        </>
      )}

      {/* Cost */}
      {cost !== undefined && (
        <>
          <span>{formatCost(cost, currency)}</span>
          <div className="w-px h-3 bg-[var(--color-separator)]" />
        </>
      )}

      {/* Context usage */}
      {contextMax !== undefined && contextMax > 0 && (
        <>
          <div className="flex items-center gap-1.5" title={t('status.context')}>
            <Gauge size={11} className="text-[var(--color-text-tertiary)]" />
            <div className="w-14 h-1.5 rounded-full bg-[var(--color-bg-tertiary)] overflow-hidden">
              <div
                className="h-full rounded-full"
                style={{ width: `${contextPercent}%`, backgroundColor: contextColor }}
              />
            </div>
            <span className="font-mono">{contextPercent}%</span>
            <span className="text-[var(--color-text-tertiary)]">
              {formatCompactTokens(contextTokens)}/{formatCompactTokens(contextMax)}
            </span>
          </div>
          <div className="w-px h-3 bg-[var(--color-separator)]" />
        </>
      )}

      {/* Agent status */}
      <Badge variant={status.variant} dot size="sm">
        {t(status.labelKey)}
      </Badge>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Git branch */}
      {gitBranch && (
        <>
          <span className="inline-flex items-center gap-1">
            <GitBranch size={10} className="text-[var(--color-text-tertiary)]" />
            <span>{gitBranch}</span>
            {gitAhead > 0 && (
              <span className="inline-flex items-center gap-0.5 text-[#4caf50]">
                <ArrowUp size={9} />
                <span>{gitAhead}</span>
              </span>
            )}
            {gitBehind > 0 && (
              <span className="inline-flex items-center gap-0.5 text-[#2196f3]">
                <ArrowDown size={9} />
                <span>{gitBehind}</span>
              </span>
            )}
          </span>
          <div className="w-px h-3 bg-[var(--color-separator)]" />
        </>
      )}

      {/* Command palette hint */}
      <span className="inline-flex items-center gap-1 text-[var(--color-text-tertiary)]">
        <Command size={10} />
        <span>{t('status.commands')}</span>
      </span>

      {/* Terminal toggle */}
      {onToggleTerminal && (
        <>
          <div className="w-px h-3 bg-[var(--color-separator)]" />
          <button
            type="button"
            onClick={onToggleTerminal}
            className={`inline-flex items-center gap-1 transition-colors cursor-pointer ${
              terminalOpen ? 'text-[var(--color-brand)]' : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]'
            }`}
            title={terminalOpen ? t('status.hideTerminal') : t('status.toggleTerminal')}
            aria-label={t('status.toggleTerminal')}
          >
            <Terminal size={12} />
            <span>{t('status.terminal')}</span>
          </button>
        </>
      )}
      </div>
    </div>
  );
}

StatusBar.displayName = 'StatusBar';
