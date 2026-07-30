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
}

export function CompactSummary({
  content,
  collapsed: initialCollapsed = true,
  maxCollapsedLines = 8,
}: CompactSummaryProps) {
  const [isCollapsed, setIsCollapsed] = useState(initialCollapsed);
  const lines = content.split('\n');

  const displayLines = isCollapsed
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
            {isCollapsed
              ? `... ${lines.length - maxCollapsedLines} more lines`
              : `(${lines.length} lines total)`}
          </Text>
        )}
      </Box>
    </Box>
  );
}
