import { useChatStore } from '../../stores/chatStore';

export function StatusBar() {
  const statusText = useChatStore((s) => s.statusText);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const connectionStatus = useChatStore((s) => s.connectionStatus);
  const totalTokens = useChatStore((s) => s.totalTokens);
  const error = useChatStore((s) => s.error);

  const total = totalTokens.inputTokens + totalTokens.outputTokens;
  const statusClass = connectionStatus === 'connected'
    ? 'connected'
    : connectionStatus === 'disconnected'
      ? 'disconnected'
      : 'connecting';

  return (
    <div className="status-bar">
      <div className="status-bar-left">
        <span className={`status-indicator ${statusClass}`}>●</span>
        <span className="status-model">
          {connectionStatus === 'connected'
            ? (isStreaming ? 'Generating...' : statusText)
            : connectionStatus}
        </span>
        {error && (
          <span className="status-error" title={error}>⚠ {error.slice(0, 50)}</span>
        )}
      </div>
      <div className="status-bar-right">
        {total > 0 && (
          <span className="status-tokens">{total.toLocaleString()} tokens</span>
        )}
      </div>
    </div>
  );
}
