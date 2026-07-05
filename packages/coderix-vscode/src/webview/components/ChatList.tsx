/**
 * ChatList.tsx — Scrollable message list with tool execution cards,
 * thinking block, and subagent tree.
 */

import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ThinkingBlock } from './ThinkingBlock';
import { SubagentTree } from './SubagentTree';
import type { ChatMessage, ToolState, SubagentState } from '../app';

interface ChatListProps {
  messages: ChatMessage[];
  streamingText: string;
  thinkingText: string;
  tools: ToolState[];
  subagents: Map<string, SubagentState>;
  onFileClick: (path: string) => void;
}

function ToolCard({ tool }: { tool: ToolState }): h.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const hasOutput = (tool.resultText && tool.resultText.length > 0);

  return (
    <div
      class={`tool-card ${tool.status === 'running' ? 'tool-running' : tool.status === 'error' ? 'tool-error' : 'tool-completed'} ${hasOutput ? 'tool-has-output' : ''}`}
    >
      <button class="tool-card-header" onClick={() => hasOutput && setExpanded(!expanded)}>
        <span class="tool-icon">
          {tool.status === 'running' ? <span class="tool-spinner" /> : tool.status === 'error' ? '✗' : '✓'}
        </span>
        <span class="tool-name">{tool.name}</span>
        {tool.status === 'error' && <span class="tool-error-text">— {tool.error}</span>}
      </button>
      {expanded && hasOutput && (
        <div class="tool-card-output">
          <pre>{tool.resultText}</pre>
        </div>
      )}
    </div>
  );
}

export function ChatList({
  messages, streamingText, thinkingText, tools, subagents, onFileClick,
}: ChatListProps): h.JSX.Element {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingText, tools, thinkingText]);

  return (
    <div class="chat-list">
      {messages.map((msg) => (
        msg.role === 'user' ? (
          <div key={msg.id} class="message message-user-box">
            <div class="message-text"><MarkdownRenderer text={msg.text} onFileClick={onFileClick} /></div>
          </div>
        ) : (
          <div key={msg.id} class={`message message-${msg.role}`}>
            <span class="message-role">
              {msg.role === 'system' ? 'System' : 'Coder'}
            </span>
            <div class="message-text"><MarkdownRenderer text={msg.text} onFileClick={onFileClick} /></div>
          </div>
        )
      ))}

      {/* Tool execution cards */}
      {tools.map((tool) => (
        <ToolCard key={tool.toolId} tool={tool} />
      ))}

      {/* Thinking / reasoning block */}
      {thinkingText && (
        <ThinkingBlock content={thinkingText} isStreaming={!streamingText} />
      )}

      {/* Streaming response */}
      {streamingText && (
        <div class="message message-assistant streaming">
          <span class="message-role">Coder</span>
          <div class="message-text"><MarkdownRenderer text={streamingText} onFileClick={onFileClick} /></div>
          <span class="cursor">|</span>
        </div>
      )}

      {/* Sub-agent progress cards */}
      <SubagentTree subagents={subagents} />

      <div ref={bottomRef} />
    </div>
  );
}
