import React, { useState } from 'react';
import { Box, Text, SAFE_BORDER, useInput } from '@coderix/tui';

export interface SecretPromptProps {
  /** Which MCP server this secret belongs to. */
  server: string;
  /** The environment variable being collected, e.g. GITHUB_PERSONAL_ACCESS_TOKEN. */
  envVar: string;
  /** Optional 1-based position for a multi-secret run. */
  progress?: { index: number; total: number };
  onSubmit: (value: string) => void;
  onSkip: () => void;
}

/**
 * Masked free-text prompt for a single secret. Echoes bullets instead of the
 * value so a pasted API key never appears in the terminal or scrollback.
 */
export function SecretPrompt({ server, envVar, progress, onSubmit, onSkip }: SecretPromptProps) {
  const [value, setValue] = useState('');

  useInput((input, key) => {
    if (key.escape || (key.ctrl && (input === 'c' || input === '\x03')) || input === '\x03') {
      onSkip();
      return;
    }
    if (key.return) {
      if (value.length > 0) onSubmit(value);
      else onSkip();
      return;
    }
    if (key.backspace || key.delete) {
      setValue((prev) => prev.slice(0, -1));
      return;
    }
    // Printable / pasted characters arrive in `input`.
    if (input && !key.ctrl && !key.meta) {
      setValue((prev) => prev + input);
    }
  });

  return (
    <Box flexDirection="column" borderStyle={SAFE_BORDER} borderColor="ansi:cyan" paddingX={1} paddingY={1}>
      {progress && (
        <Text dimColor>
          Secret {progress.index}/{progress.total}
        </Text>
      )}
      <Text bold color="ansi:cyan">
        MCP server "{server}" needs a key
      </Text>
      <Box marginTop={1}>
        <Text dimColor>{envVar}: </Text>
        <Text color="ansi:white">{value.length > 0 ? '•'.repeat(value.length) : '▰'}</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Enter to save · Esc to skip (set it later in ~/.coderix/mcp/secrets.json)</Text>
      </Box>
    </Box>
  );
}
