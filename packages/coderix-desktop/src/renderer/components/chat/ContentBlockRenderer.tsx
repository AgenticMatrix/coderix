import React from 'react';
import ReactMarkdown from 'react-markdown';
import { motion } from 'framer-motion';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolCallCard } from './ToolCallCard';
import { CodeBlock } from './CodeBlock';
import type { StreamBlock } from '../../types';

export interface ContentBlockRendererProps {
  /** The content block to render */
  block: StreamBlock;
  /** Whether this is still streaming */
  isStreaming?: boolean;
}

/**
 * Renders different content block types:
 * - text: Markdown via react-markdown
 * - tool_use: Tool invocation card
 * - thinking: Collapsible thinking panel
 * - tool_result / system: Plain text with appropriate styling
 */
export function ContentBlockRenderer({
  block,
  isStreaming = false,
}: ContentBlockRendererProps): React.ReactElement {
  switch (block.type) {
    case 'text':
      return (
        <div className="prose prose-sm max-w-none text-[var(--color-text-primary)]">
          <ReactMarkdown
            components={{
              // Code blocks — use dedicated CodeBlock component
              pre({ children }) {
                return <>{children}</>;
              },
              code({ children, className, ...props }) {
                const match = /language-(\w+)/.exec(className || '');
                const codeStr = String(children).replace(/\n$/, '');
                const isInline = !match && !codeStr.includes('\n');
                if (isInline) {
                  return (
                    <code
                      {...props}
                      className="px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] font-mono text-[12px]"
                    >
                      {children}
                    </code>
                  );
                }
                return (
                  <CodeBlock
                    code={codeStr}
                    language={match ? match[1] : ''}
                    maxLines={50}
                  />
                );
              },
              // Links
              a({ children, href, ...props }) {
                return (
                  <a
                    {...props}
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[var(--color-link)] hover:underline"
                  >
                    {children}
                  </a>
                );
              },
              // Blockquotes
              blockquote({ children, ...props }) {
                return (
                  <blockquote
                    {...props}
                    className="border-l-[3px] border-[var(--color-brand)] pl-4 my-2 text-[var(--color-text-secondary)] italic"
                  >
                    {children}
                  </blockquote>
                );
              },
              // Lists
              ul({ children, ...props }) {
                return <ul {...props} className="list-disc pl-5 my-1 space-y-0.5">{children}</ul>;
              },
              ol({ children, ...props }) {
                return <ol {...props} className="list-decimal pl-5 my-1 space-y-0.5">{children}</ol>;
              },
              // Headings
              h1({ children, ...props }) {
                return <h1 {...props} className="text-xl font-bold mt-4 mb-2">{children}</h1>;
              },
              h2({ children, ...props }) {
                return <h2 {...props} className="text-lg font-semibold mt-3 mb-1.5">{children}</h2>;
              },
              h3({ children, ...props }) {
                return <h3 {...props} className="text-base font-semibold mt-2 mb-1">{children}</h3>;
              },
              // Table
              table({ children, ...props }) {
                return (
                  <div className="overflow-x-auto my-2 rounded-[var(--radius-lg)] border border-[var(--color-separator)]">
                    <table {...props} className="w-full text-sm">
                      {children}
                    </table>
                  </div>
                );
              },
              th({ children, ...props }) {
                return <th {...props} className="px-3 py-2 text-left font-medium bg-[var(--color-bg-tertiary)] border-b border-[var(--color-separator)]">{children}</th>;
              },
              td({ children, ...props }) {
                return <td {...props} className="px-3 py-2 border-b border-[var(--color-separator)] last:border-b-0">{children}</td>;
              },
              // Horizontal rule
              hr() {
                return <hr className="my-4 border-[var(--color-separator)]" />;
              },
            }}
          >
            {block.content ?? ''}
          </ReactMarkdown>
          {/* Blinking cursor during streaming */}
          {isStreaming && (
            <motion.span
              animate={{ opacity: [1, 0] }}
              transition={{ repeat: Infinity, duration: 0.8 }}
              className="inline-block w-2 h-4 bg-[var(--color-text-primary)] ml-0.5 align-text-bottom"
            />
          )}
        </div>
      );

    case 'tool_use':
      return (
        <ToolCallCard
          toolName={block.toolName ?? 'Unknown'}
          toolInput={block.toolInput}
          state={block.state ?? 'executing'}
          toolId={block.toolId}
        />
      );

    case 'thinking':
      return (
        <ThinkingBlock
          content={block.content ?? ''}
          isStreaming={isStreaming}
          defaultExpanded={false}
        />
      );

    case 'tool_result':
      return (
        <div className="my-1 px-2 py-1.5 text-xs rounded-[var(--radius-sm)] bg-[var(--color-bg-secondary)]/50 text-[var(--color-text-tertiary)] font-mono border border-[var(--color-separator)]">
          <span className="text-[var(--color-success)]">→</span> {block.toolName}: {truncateText(block.content ?? '', 120)}
        </div>
      );

    case 'system':
      return (
        <div className="my-1 px-3 py-1.5 text-xs rounded-[var(--radius-md)] bg-[var(--color-warning)]/10 text-[var(--color-warning)] border border-[var(--color-warning)]/20">
          {block.content}
        </div>
      );

    default:
      return (
        <div className="my-1 px-3 py-1.5 text-xs text-[var(--color-text-tertiary)]">
          {block.content ?? JSON.stringify(block)}
        </div>
      );
  }
}

ContentBlockRenderer.displayName = 'ContentBlockRenderer';

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '…';
}
