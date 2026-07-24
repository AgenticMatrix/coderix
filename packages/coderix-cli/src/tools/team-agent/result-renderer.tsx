import React from 'react';
import { Box, Text } from '@coderix/ink';
import type { ToolResultRendererProps } from '../types.js';

/**
 * TeamAgent result renderer — one-line spawn summary.
 * Renders: "└ Teammate 'name' (agentId) spawned in team 'teamName'."
 */
export function TeamAgentResultRenderer(props: ToolResultRendererProps): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Text dimColor>└ {props.content}</Text>
    </Box>
  );
}
