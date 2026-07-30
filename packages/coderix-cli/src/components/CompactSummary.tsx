/**
 * CompactSummary.tsx — Renders a compaction summary user message.
 *
 * Matches claude-code-best's CompactSummary: bold heading with
 * collapsible summary content underneath.
 */

import React, { useState } from 'react';
import { Box, Text } from '@coderix/ink';

interface CompactSummaryProps {
  /** The formatted compact summary content. */
  content: string;
  /** Whether the summary is collapsed by default. */
  collapsed?: boolean;
  /** Maximum visible lines when collapsed. */
  maxCollapsedLines?: number;
  /** Global content-expand toggle (Ctrl+O). When true, force-expand all content. */
  contentExpanded?: boolean;
}

export function CompactSummary({
  content,
  collapsed: initialCollapsed = true,
  maxCollapsedLines = 8,
  contentExpanded = false,
}: CompactSummaryProps) {
  const [isCollapsed, setIsCollapsed] = useState(initialCollapsed);

  // Ctrl+O toggles all content — use contentExpanded to override local state
  const effectiveCollapsed = contentExpanded ? false : isCollapsed;

  const lines = content.split('\n');

  const displayLines = effectiveCollapsed
    ? lines.slice(0, maxCollapsedLines)
    : lines;

  if (!content) return null;

  return (
    <Box flexDirection="column" marginY={1}>
      <Text bold>Conversation summarized to free up context</Text>

      <Box flexDirection="column" marginLeft={2} marginTop={1}>
        {displayLines.map((line, i) => (
          <Text key={i} dimColor>
            {line || ' '}
          </Text>
        ))}

        {lines.length > maxCollapsedLines && (
          <Text dimColor>
            {effectiveCollapsed
              ? `... ${lines.length - maxCollapsedLines} more lines (Ctrl+O to expand)`
              : `(${lines.length} lines total)`}
          </Text>
        )}
      </Box>
    </Box>
  );
}
