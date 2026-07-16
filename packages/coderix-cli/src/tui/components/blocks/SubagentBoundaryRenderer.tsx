import React from 'react';
import { Box, Text } from '@coderix/ink';

interface Props {
  agentType: string;
  agentId: string;
  boundary: 'start' | 'end';
}

/**
 * Renders a sub-agent conversation boundary marker in the chat view.
 * Separates sub-agent transcripts from the main conversation when resuming.
 */
export const SubagentBoundaryRenderer: React.FC<Props> = ({
  agentType,
  agentId,
  boundary,
}) => {
  const label =
    boundary === 'start'
      ? `Sub-agent: ${agentType} (${agentId.slice(0, 8)})`
      : `End: ${agentType}`;

  return (
    <Box flexDirection="row" paddingY={1}>
      <Text dimColor>
        {boundary === 'start' ? '┌' : '└'}── {label} ──
        {boundary === 'start' ? '┐' : '┘'}
      </Text>
    </Box>
  );
};
