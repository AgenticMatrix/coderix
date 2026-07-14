import React from 'react';
import { Box, Text } from '@coderix/ink';
import { OutputLine } from '../shared/OutputLine.js';
import type { ToolResultRendererProps } from '../types.js';

export function ReadResultRenderer(props: ToolResultRendererProps): React.ReactNode {
  const { content, isError } = props;

  const lines = content ? content.split('\n').filter(l => l !== '') : [];
  const emptiness = lines.length === 0;

  return (
    <Box flexDirection="column">
      {emptiness ? (
        <Text color={isError ? 'ansi:red' : 'ansi:green'} dimColor>
          {isError ? '(error — no output)' : '(empty)'}
        </Text>
      ) : (
        lines.map((line, i) => (
          <OutputLine key={`out-${i}`} line={line} />
        ))
      )}
    </Box>
  );
}
