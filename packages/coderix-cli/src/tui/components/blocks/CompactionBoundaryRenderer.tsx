import React from 'react';

export interface CompactionBoundaryRendererProps {
  removedCount: number;
  reason: string;
  beforeTokens?: number;
  afterTokens?: number;
}

/**
 * Renders a context compaction boundary separator.
 *
 * Matches claude-code-best's CompactBoundaryMessage: a simple dim line
 * indicating that conversation compaction occurred.
 */
export function CompactionBoundaryRenderer({
  removedCount: _removedCount,
  reason: _reason,
  beforeTokens: _beforeTokens,
  afterTokens: _afterTokens,
}: CompactionBoundaryRendererProps) {
  return null;
}
