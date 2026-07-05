import { h } from 'preact';
import type { UsageInfo } from '../../types/webviewProtocol';

interface StatusBarProps {
  status: string;
  model: string;
  usage: UsageInfo | null;
  contextWindow?: number;
  isBusy: boolean;
  sessionId: string;
  sessionTitle: string;
  permissionMode?: 'plan' | 'ask' | 'auto';
  onNewSession: () => void;
  onSessionClick: () => void;
  onPermissionModeToggle?: () => void;
}

export function StatusBar({
  status,
  model,
  usage,
  contextWindow,
  isBusy,
  sessionId,
  sessionTitle,
  permissionMode,
  onNewSession,
  onSessionClick,
  onPermissionModeToggle,
}: StatusBarProps): h.JSX.Element {
  const usagePct = contextWindow && usage && contextWindow > 0
    ? (usage.total / contextWindow) * 100
    : undefined;

  const usageColor = usagePct !== undefined
    ? usagePct > 80 ? 'var(--color-error)' : usagePct > 50 ? 'var(--color-warn)' : 'var(--color-success)'
    : undefined;

  return (
    <div class="status-bar">
      <span class={`status-indicator ${isBusy ? 'status-busy' : 'status-idle'}`}>
        {isBusy ? '●' : '○'} {status}
      </span>
      {model && <span class="status-model">{model}</span>}
      {permissionMode && onPermissionModeToggle && (
        <button class="status-mode-btn" onClick={onPermissionModeToggle} title={`Permission mode: ${permissionMode} (click to cycle)`}>
          {permissionMode === 'auto' ? '🟢' : permissionMode === 'plan' ? '🔵' : '🟡'} {permissionMode}
        </button>
      )}
      {usagePct !== undefined && (
        <div class="status-usage-bar" title={`${usage!.total.toLocaleString()} / ${contextWindow!.toLocaleString()} tokens`}>
          <div class="status-usage-fill" style={{ width: `${Math.min(usagePct, 100)}%`, backgroundColor: usageColor }} />
        </div>
      )}
      {sessionTitle && (
        <span class="status-session" title={sessionId} onClick={onSessionClick}>
          {sessionTitle}
        </span>
      )}
      <button class="new-session-btn" onClick={onNewSession} title="New session">
        +
      </button>
      {usage && (
        <span class="status-usage">
          {usage.total.toLocaleString()} tokens
          {usage.cache > 0 ? ` (cache: ${usage.cache.toLocaleString()})` : ''}
          {usage.cost_usd ? ` · $${usage.cost_usd.toFixed(4)}` : ''}
        </span>
      )}
    </div>
  );
}
