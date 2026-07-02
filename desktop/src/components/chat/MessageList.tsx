import { useRef, useEffect } from 'react';
import type { ChatMessage } from '../../stores/chatStore';
import { MessageBubble } from './MessageBubble';
import { useChatStore } from '../../stores/chatStore';
import { getAgentBridge } from '../../App';

interface MessageListProps {
  messages: ChatMessage[];
}

const QUICK_HINTS = [
  'List files in this project',
  'Explain the codebase structure',
  'Show git status',
  'Find all TODO comments',
];

export function MessageList({ messages }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const isStreaming = useChatStore((s) => s.isStreaming);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, messages[messages.length - 1]?.content.length]);

  const handleHint = (hint: string) => {
    const bridge = getAgentBridge();
    if (bridge) bridge.runAgentTurn(hint);
  };

  if (messages.length === 0 && !isStreaming) {
    return (
      <div className="welcome-screen">
        <div className="welcome-content">
          <div className="welcome-icon">◈</div>
          <h1 className="welcome-title">Coderix Desktop</h1>
          <p className="welcome-subtitle">
            Your AI coding assistant. Ask anything — read, write, edit code,
            run commands, search the web.
          </p>
          <div className="welcome-hints">
            {QUICK_HINTS.map((h) => (
              <button key={h} className="welcome-hint" onClick={() => handleHint(h)}>
                {h}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="message-list">
      <div className="message-list-inner">
        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
