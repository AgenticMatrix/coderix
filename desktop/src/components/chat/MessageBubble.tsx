import { useState } from 'react';
import type { ChatMessage, ToolUseBlock } from '../../stores/chatStore';
import { MarkdownRenderer } from './MarkdownRenderer';
import { CodeBlock } from './CodeBlock';

interface MessageBubbleProps {
  message: ChatMessage;
}

function ToolCard({ block }: { block: ToolUseBlock }) {
  const [expanded, setExpanded] = useState(false);
  const stateClass = `tool-card-${block.state}`;

  const icon = {
    pending: '○', executing: '◉', done: '✓', error: '✕',
  }[block.state] || '○';

  return (
    <div className={`tool-card ${stateClass}`}>
      <div className="tool-card-header" onClick={() => setExpanded(!expanded)}>
        <span className="tool-card-icon">{icon}</span>
        <span className="tool-card-name">{block.toolName}</span>
        {block.duration != null && (
          <span className="tool-card-duration">{(block.duration / 1000).toFixed(1)}s</span>
        )}
        <span className="tool-card-state">{block.state}</span>
      </div>
      {expanded && block.result && (
        <div className="tool-card-body">
          <CodeBlock code={block.result.content} language="" maxLines={30} />
        </div>
      )}
    </div>
  );
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const [thinkingExpanded, setThinkingExpanded] = useState(false);

  if (isSystem) {
    return (
      <div className="message message-system">
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
                  <CodeBlock code={block.content.slice(0, 2000)} language="" maxLines={20} />
                </div>
              </div>
            );
          }
          return null;
        })}
      </div>
    );
  }

  const toolBlocks = message.blocks.filter((b): b is ToolUseBlock => b.type === 'tool_use');

  return (
    <div className={`message ${isUser ? 'message-user' : 'message-assistant'}`}>
      {/* Role indicator */}
      <div className="message-role">
        {isUser ? 'You' : 'Coderix'}
      </div>

      {/* Thinking */}
      {message.thinking && (
        <div className="message-thinking">
          <button className="thinking-toggle" onClick={() => setThinkingExpanded(!thinkingExpanded)}>
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

      {/* Tool use cards */}
      {toolBlocks.map((block) => (
        <ToolCard key={block.toolId} block={block} />
      ))}

      {/* Token info */}
      {message.tokenUsage && (
        <div className="message-token-info">
          <span>↑{message.tokenUsage.inputTokens.toLocaleString()}</span>
          <span>↓{message.tokenUsage.outputTokens.toLocaleString()}</span>
        </div>
      )}
    </div>
  );
}
