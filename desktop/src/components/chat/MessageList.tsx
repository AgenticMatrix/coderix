import { useRef, useEffect } from 'react';
import type { ChatMessage } from '../../stores/chatStore';
import { MessageBubble } from './MessageBubble';

interface MessageListProps {
  messages: ChatMessage[];
}

export function MessageList({ messages }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages.length, messages[messages.length - 1]?.content.length]);

  if (messages.length === 0) {
    return (
      <div className="message-list-empty">
        <div className="message-list-welcome">
          <h1 className="welcome-title">Coderix Desktop</h1>
          <p className="welcome-subtitle">
            Your AI coding assistant with a native GUI
          </p>
          <div className="welcome-shortcuts">
            <div className="welcome-shortcut">
              <kbd>Enter</kbd> Send message
            </div>
            <div className="welcome-shortcut">
              <kbd>Shift+Enter</kbd> New line
            </div>
            <div className="welcome-shortcut">
              <kbd>Esc</kbd> Interrupt
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="message-list" ref={containerRef}>
      {messages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
