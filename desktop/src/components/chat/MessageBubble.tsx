import { useState } from 'react';
import type { ChatMessage, ToolUseBlock } from '../../stores/chatStore';
import { MarkdownRenderer } from './MarkdownRenderer';
import { CodeBlock } from './CodeBlock';

interface MessageBubbleProps {
  message: ChatMessage;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const [thinkingExpanded, setThinkingExpanded] = useState(false);

  if (isSystem) {
    // System messages show tool results
    return (
      <div className="message-bubble message-system">
        {message.blocks.map((block, i) => {
          if (block.type === 'tool_result') {
            return (
              <div key={i} className={`tool-result ${block.isError ? 'tool-result-error' : ''}`}>
                <div className="tool-result-header">
                  <span className="tool-result-name">{block.toolName || 'Result'}</span>
                  {block.duration != null && (
                    <span className="tool-result-duration">{(block.duration / 1000).toFixed(1)}s</span>
                  )}
                </div>
                <div className="tool-result-content">
                  <CodeBlock code={block.content} language="" maxLines={30} />
                </div>
              </div>
            );
          }
          return null;
        })}
      </div>
    );
  }

  return (
    <div className={`message-bubble ${isUser ? 'message-user' : 'message-assistant'}`}>
      <div className="message-role">
        {isUser ? 'You' : 'Coderix'}
      </div>

      {/* Thinking section */}
      {message.thinking && (
        <div className="message-thinking">
          <button
            className="thinking-toggle"
            onClick={() => setThinkingExpanded(!thinkingExpanded)}
          >
            {thinkingExpanded ? '▾' : '▸'} Thinking
          </button>
          {thinkingExpanded && (
            <div className="thinking-content">
              <MarkdownRenderer content={message.thinking} />
            </div>
          )}
        </div>
      )}

      {/* Text content */}
      {message.content && (
        <div className="message-content">
          <MarkdownRenderer content={message.content} />
        </div>
      )}

      {/* Tool use blocks */}
      {message.blocks
        .filter((b): b is ToolUseBlock => b.type === 'tool_use')
        .map((block) => (
          <div key={block.toolId} className={`tool-use tool-use-${block.state}`}>
            <div className="tool-use-header">
              <span className="tool-use-icon">
                {block.state === 'pending' && '◷'}
                {block.state === 'executing' && '⚙'}
                {block.state === 'done' && '✓'}
                {block.state === 'error' && '✕'}
              </span>
              <span className="tool-use-name">{block.toolName}</span>
              <span className="tool-use-state">{block.state}</span>
              {block.duration != null && (
                <span className="tool-use-duration">
                  {(block.duration / 1000).toFixed(1)}s
                </span>
              )}
            </div>
            {block.result && (
              <div className={`tool-use-result ${block.result.isError ? 'tool-use-result-error' : ''}`}>
                <CodeBlock
                  code={block.result.content}
                  language=""
                  maxLines={25}
                />
              </div>
            )}
          </div>
        ))}

      {/* Token usage */}
      {message.tokenUsage && (
        <div className="message-token-info">
          <span title="Input tokens">↑{message.tokenUsage.inputTokens.toLocaleString()}</span>
          <span title="Output tokens">↓{message.tokenUsage.outputTokens.toLocaleString()}</span>
        </div>
      )}
    </div>
  );
}
