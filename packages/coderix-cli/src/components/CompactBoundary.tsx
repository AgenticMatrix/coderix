/**
 * CompactBoundary.tsx — Renders a compaction boundary separator.
 *
 * Matches claude-code-best's CompactBoundaryMessage: a simple dim line
 * indicating that conversation compaction occurred.
 */

import React from 'react';
import { Box, Text } from '@coderix/ink';

export function CompactBoundary() {
  return (
    <Box marginY={1}>
      <Text dimColor>{'✦'} Conversation compacted</Text>
    </Box>
  );
}
