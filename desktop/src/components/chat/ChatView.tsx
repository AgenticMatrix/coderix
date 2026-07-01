import { useCallback } from 'react';
import { useChatStore } from '../../stores/chatStore';
import { getAgentBridge } from '../../App';
import { MessageList } from './MessageList';
import { InputBox } from './InputBox';

interface ChatViewProps {
  onSendMessage: (text: string) => Promise<void>;
  onInterrupt: () => Promise<void>;
}

export function ChatView({ onSendMessage, onInterrupt }: ChatViewProps) {
  const messages = useChatStore((s) => s.messages);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const inputText = useChatStore((s) => s.inputText);
  const setInputText = useChatStore((s) => s.setInputText);
  const error = useChatStore((s) => s.error);
  const sessionId = useChatStore((s) => s.sessionId);

  const handleSend = useCallback(async () => {
    if (!inputText.trim() || isStreaming) return;
    await onSendMessage(inputText);
  }, [inputText, isStreaming, onSendMessage]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
      if (e.key === 'Escape') {
        if (isStreaming) {
          onInterrupt();
        }
      }
    },
    [handleSend, isStreaming, onInterrupt],
  );

  const handleNewSession = useCallback(async () => {
    const bridge = getAgentBridge();
    if (bridge) {
      await bridge.createSession();
    }
  }, []);

  return (
    <div className="chat-view">
      {/* Header */}
      <div className="chat-header">
        <div className="chat-header-left">
          <span className="chat-header-title">Coderix</span>
          {sessionId && (
            <span className="chat-header-session" title={sessionId}>
              {sessionId.slice(0, 8)}...
            </span>
          )}
        </div>
        <div className="chat-header-right">
          <button
            className="btn-icon"
            onClick={handleNewSession}
            title="New Session"
          >
            + New
          </button>
        </div>
      </div>

      {/* Messages */}
      <MessageList messages={messages} />

      {/* Error banner */}
      {error && (
        <div className="chat-error-banner">
          <span className="chat-error-text">{error}</span>
          <button
            className="btn-icon"
            onClick={() => useChatStore.getState().clearError()}
          >
            ✕
          </button>
        </div>
      )}

      {/* Input area */}
      <div className="chat-input-area">
        {isStreaming && (
          <div className="chat-interrupt-bar">
            <button className="btn-interrupt" onClick={onInterrupt}>
              ■ Interrupt
            </button>
          </div>
        )}
        <InputBox
          value={inputText}
          onChange={setInputText}
          onSend={handleSend}
          onKeyDown={handleKeyDown}
          disabled={isStreaming}
        />
      </div>
    </div>
  );
}
