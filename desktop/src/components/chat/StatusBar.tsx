import { useChatStore } from '../../stores/chatStore';

export function StatusBar() {
  const statusText = useChatStore((s) => s.statusText);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const connectionStatus = useChatStore((s) => s.connectionStatus);
  const totalTokens = useChatStore((s) => s.totalTokens);
  const error = useChatStore((s) => s.error);

  const total = totalTokens.inputTokens + totalTokens.outputTokens;
  const statusColor =
    connectionStatus === 'connected'
      ? error
        ? '#f85149'
        : isStreaming
          ? '#58a6ff'
          : '#3fb950'
      : '#d2991d';

  const statusIcon =
    connectionStatus === 'connected' ? '●' : '◐';

  return (
    <div className="status-bar">
      <div className="status-bar-left">
        <span className="status-indicator" style={{ color: statusColor }}>
          {statusIcon}
        </span>
        <span className="status-text">
          {connectionStatus === 'connected'
            ? statusText
            : connectionStatus === 'reconnecting'
              ? 'Reconnecting...'
              : 'Connecting...'}
        </span>
        {error && (
          <span className="status-error" title={error}>
            ⚠ {error.slice(0, 50)}{error.length > 50 ? '...' : ''}
          </span>
        )}
      </div>
      <div className="status-bar-right">
        {total > 0 && (
          <span className="status-tokens" title={`Input: ${totalTokens.inputTokens.toLocaleString()} | Output: ${totalTokens.outputTokens.toLocaleString()}`}>
            Tokens: {total.toLocaleString()}
          </span>
        )}
        <span className={`status-connection status-${connectionStatus}`}>
          {connectionStatus}
        </span>
      </div>
    </div>
  );
}
