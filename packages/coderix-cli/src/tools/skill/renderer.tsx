/**
 * Skill tool renderer — displays skill invocation in the TUI.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { useToolTimer } from '../shared/useToolTimer.js';
import type { ToolUseRendererProps } from '../types.js';

export function SkillRenderer(props: ToolUseRendererProps): React.ReactNode {
  const skillName = props.input.skill as string | undefined;
  const isDone = props.state === 'done';
  const isExecuting = props.state === 'executing';
  const isError = props.state === 'error';
  const { elapsedSecs, blinkOn } = useToolTimer(isExecuting);

  if (isError) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="red">❌ </Text>
          <Text bold>Skill</Text>
          {skillName ? <Text dimColor> {skillName}</Text> : null}
          <Text color="red"> not found</Text>
        </Text>
      </Box>
    );
  }

  if (isDone) {
    const meta = props.result?.metadata;
    const activatedTools = meta?.activatedTools as string[] | undefined;
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="green">● </Text>
          <Text bold>Skill</Text>
          {skillName ? <Text> {skillName}</Text> : null}
          <Text dimColor> loaded</Text>
        </Text>
        {activatedTools && activatedTools.length > 0 ? (
          <Box paddingLeft={3}>
            <Text dimColor>Activated: {activatedTools.join(', ')}</Text>
          </Box>
        ) : null}
      </Box>
    );
  }

  // Executing / pending
  const indicator = isExecuting ? (blinkOn ? '●' : '○') : '○';

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color="yellow">{indicator} </Text>
        <Text bold>Skill</Text>
        {skillName ? <Text dimColor> /{skillName}</Text> : null}
        {isExecuting ? (
          <Text dimColor color="yellow">
            {' '}
            loading {elapsedSecs}s
          </Text>
        ) : null}
      </Text>
    </Box>
  );
}
