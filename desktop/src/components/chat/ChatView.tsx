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
      if (e.key === 'Escape' && isStreaming) {
        onInterrupt();
      }
    },
    [handleSend, isStreaming, onInterrupt],
  );

  return (
    <div className="chat-view">
      <MessageList messages={messages} />

      {error && (
        <div className="chat-error-banner">
          <span className="chat-error-text">{error}</span>
          <button className="btn-icon" onClick={() => useChatStore.getState().clearError()}>✕</button>
        </div>
      )}

      <div className="chat-input-area">
        {isStreaming && (
          <div className="chat-interrupt-bar">
            <button className="btn-interrupt" onClick={onInterrupt}>
              ■ Stop generating
            </button>
          </div>
        )}
        <div className="chat-input-inner">
          <InputBox
            value={inputText}
            onChange={setInputText}
            onSend={handleSend}
            onKeyDown={handleKeyDown}
            disabled={isStreaming}
          />
        </div>
      </div>
    </div>
  );
}
