import React from 'react';
import { ContentBlockRenderer } from '../ContentBlockRenderer';
import { ThinkingBlock } from '../ThinkingBlock';
import { ToolRenderer } from '../ToolRenderer';
import { formatThinkingDuration, type TrajectoryWorkRow } from './trajectoryTypes';

/**
 * Renders one "work" row inside the collapsible 已工作 region, in chronological
 * order:
 *   - reasoning → ThinkingBlock ("思考" · 持续了几秒, collapsed by default)
 *   - tool      → ToolRenderer (Chinese label + summary, collapsed by default)
 *   - text      → intermediate assistant text (ContentBlockRenderer)
 */
export function TrajectoryMessageRow({
  row,
  isStreaming = false,
  reveal = false,
  durationMs,
}: {
  row: TrajectoryWorkRow;
  isStreaming?: boolean;
  reveal?: boolean;
  durationMs?: number;
}): React.ReactElement | null {
  if (row.kind === 'reasoning') {
    const content = row.blocks.map((b) => b.content ?? '').join('\n');
    return (
      <ThinkingBlock
        content={content}
        isStreaming={isStreaming}
        reveal={reveal}
        label={formatThinkingDuration(durationMs)}
      />
    );
  }

  if (row.kind === 'text') {
    return (
      <>
        {row.blocks.map((block, i) => (
          <ContentBlockRenderer key={`${row.key}-${i}`} block={block} isStreaming={isStreaming} />
        ))}
      </>
    );
  }

  const block = row.blocks[0];
  if (!block) return null;
  return (
    <ToolRenderer
      toolName={block.toolName ?? 'Tool'}
      toolInput={block.toolInput}
      state={block.state}
      toolId={block.toolId}
      toolResult={block.toolResult}
      toolMetadata={block.toolMetadata}
      reveal={reveal}
    />
  );
}

TrajectoryMessageRow.displayName = 'TrajectoryMessageRow';
