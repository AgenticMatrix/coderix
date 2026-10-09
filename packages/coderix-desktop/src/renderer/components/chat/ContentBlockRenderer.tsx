import React from 'react';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolRenderer } from './ToolRenderer';
import { Markdown } from '../common/Markdown.js';
import { useT } from '../../i18n/index.js';
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
}: ContentBlockRendererProps): React.ReactElement | null {
  const t = useT();
  switch (block.type) {
    case 'text':
      return <Markdown>{block.content ?? ''}</Markdown>;

    case 'tool_use':
      return (
        <ToolRenderer
          toolName={block.toolName ?? t('common.unknown')}
          toolInput={block.toolInput}
          state={block.state}
          toolId={block.toolId}
          toolResult={block.toolResult}
          toolMetadata={block.toolMetadata}
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
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)] mb-1">
            {t('tool.output')}
          </div>
          <div className="p-2 rounded-[var(--radius-sm)] bg-[var(--color-bg-tertiary)] text-xs font-mono text-[var(--color-text-secondary)] whitespace-pre-wrap break-all max-h-48 overflow-y-auto">
            {block.content ?? ''}
          </div>
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
