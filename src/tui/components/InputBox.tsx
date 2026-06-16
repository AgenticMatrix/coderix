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

  return (
    <Box
      paddingX={1}
      paddingY={0}
      borderStyle="single"
      borderColor="grey"
      flexDirection="row"
    >
      <Box marginRight={1}>
        <Text color="cyan" bold>
          {'>'}
        </Text>
      </Box>
      <Box flexGrow={1}>
        <Text>
          {beforeCursor}
          {!isStreaming && cursorChar ? (
            <Text backgroundColor="cyan" color="black">{cursorChar}</Text>
          ) : !isStreaming ? (
            <Text color="cyan" dimColor>▌</Text>
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
