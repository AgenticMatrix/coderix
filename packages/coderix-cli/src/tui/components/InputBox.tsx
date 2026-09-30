import { Box, Text } from '@coderix/tui';
import { memo } from 'react';

interface InputBoxProps {
  inputText: string;
  cursorPosition: number;
  isStreaming: boolean;
  theme?: string;
}

/**
 * Renders the text input at the bottom of the chat.
 * Supports multi-line input (Ctrl+Enter) with a cursor on the active line.
 */
export const InputBox = memo(function InputBox({ inputText, cursorPosition, isStreaming, theme }: InputBoxProps) {
  const PROMPT_COLOR = '#A855F7';
  const CURSOR_COLOR = theme === 'light' ? '#000000' : '#FFFFFF';
  const CURSOR_TEXT_COLOR = theme === 'light' ? '#FFFFFF' : '#000000';

  // Split input into lines and locate which line holds the cursor
  const lines = inputText.split('\n');
  let cursorLine = 0;
  let cursorCol = cursorPosition;
  let accum = 0;
  for (let i = 0; i < lines.length; i++) {
    const len = lines[i]!.length;
    if (cursorPosition <= accum + len) {
      cursorLine = i;
      cursorCol = cursorPosition - accum;
      break;
    }
    accum += len + 1;
  }

  return (
    <Box flexDirection="column">
      {/* ── Multi-line input ───────────────────────────────── */}
      <Box
        paddingX={1}
        paddingY={0}
        flexDirection="column"
      >
        {lines.length === 0 ? (
          <Box flexDirection="row">
            <Box marginRight={1}>
              <Text color={PROMPT_COLOR} bold>{'❯'}</Text>
            </Box>
            <Box flexGrow={1}>
              <Text backgroundColor={CURSOR_COLOR}> </Text>
            </Box>
          </Box>
        ) : (
          lines.map((line, i) => (
            <Box key={i} flexDirection="row">
              <Box marginRight={1}>
                {i === 0 ? (
                  <Text color={PROMPT_COLOR} bold>{'❯'}</Text>
                ) : (
                  <Text> </Text>
                )}
              </Box>
              <Box flexGrow={1}>
                {i === cursorLine ? (
                  <Text>
                    {line.slice(0, cursorCol)}
                    {line[cursorCol] ? (
                      <Text backgroundColor={CURSOR_COLOR} color={CURSOR_TEXT_COLOR}>{line[cursorCol]}</Text>
                    ) : (
                      <Text backgroundColor={CURSOR_COLOR}> </Text>
                    )}
                    {line.slice(cursorCol + (line[cursorCol] ? 1 : 0))}
                  </Text>
                ) : (
                  <Text>{line}</Text>
                )}
              </Box>
            </Box>
          ))
        )}
      </Box>
    </Box>
  );
});
