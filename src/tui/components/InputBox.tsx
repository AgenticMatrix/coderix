import { Box, Text } from 'ink';

interface InputBoxProps {
  inputText: string;
  cursorPosition: number;
  isStreaming: boolean;
}

/**
 * Renders the text input line at the bottom of the chat.
 * Shows the current input buffer with a cursor at the editable position.
 */
export function InputBox({ inputText, cursorPosition, isStreaming }: InputBoxProps) {
  const cursorChar = inputText[cursorPosition] || '';
  const beforeCursor = inputText.slice(0, cursorPosition);
  const afterCursor = inputText.slice(cursorPosition + 1);

  const CURSOR_COLOR = '#4FC3F7';

  return (
    <Box
      paddingX={1}
      paddingY={0}
      borderStyle="single"
      borderColor="grey"
      flexDirection="row"
    >
      <Box marginRight={1}>
        <Text color={CURSOR_COLOR} bold>
          {'>'}
        </Text>
      </Box>
      <Box flexGrow={1}>
        <Text>
          {beforeCursor}
          {!isStreaming && cursorChar ? (
            <Text backgroundColor={CURSOR_COLOR} color="black">{cursorChar}</Text>
          ) : !isStreaming ? (
            <Text color={CURSOR_COLOR}>█</Text>
          ) : null}
          {afterCursor}
        </Text>
      </Box>
      {isStreaming && (
        <Box marginLeft={1}>
          <Text dimColor color="yellow">
            (AI thinking...)
          </Text>
        </Box>
      )}
    </Box>
  );
}
