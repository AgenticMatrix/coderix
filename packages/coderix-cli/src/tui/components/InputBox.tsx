import { Box, Text } from 'ink';

interface InputBoxProps {
  inputText: string;
  cursorPosition: number;
  isStreaming: boolean;
  /** Paste block contents keyed by ID. */
  pasteBlocks?: Record<number, string>;
  /** When true, paste content preview is shown above the input line. */
  pastePreviewVisible?: boolean;
}

const MAX_PREVIEW_LINES = 8;

/**
 * Renders the text input at the bottom of the chat.
 * Supports multi-line input (Ctrl+Enter) with a cursor on the active line.
 * When pastePreviewVisible, pasted content is shown in a preview panel
 * above the input so the user can review it before sending.
 */
export function InputBox({ inputText, cursorPosition, isStreaming, pasteBlocks, pastePreviewVisible }: InputBoxProps) {
  const CURSOR_COLOR = '#A855F7';
  const showPreview = pastePreviewVisible && pasteBlocks && Object.keys(pasteBlocks).length > 0;

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
      {/* ── Paste preview panel ────────────────────────────── */}
      {showPreview && Object.entries(pasteBlocks!).map(([id, content]) => {
        const plines = content.split(/\r?\n|\r/);
        const shown = plines.slice(0, MAX_PREVIEW_LINES);
        const overflow = plines.length - MAX_PREVIEW_LINES;

        return (
          <Box key={id} flexDirection="column">
            {shown.map((line, i) => (
              <Box key={i} paddingX={2}>
                <Text dimColor>  {line}</Text>
              </Box>
            ))}
            {overflow > 0 && (
              <Box paddingX={2}>
                <Text dimColor>  … +{overflow} more lines</Text>
              </Box>
            )}
          </Box>
        );
      })}

      {/* ── Hint line ──────────────────────────────────────── */}
      {pasteBlocks && Object.keys(pasteBlocks).length > 0 && (
        <Box paddingX={2}>
          <Text dimColor>
            {showPreview
              ? 'Ctrl+V again to hide preview'
              : 'Ctrl+V again to preview pasted text'}
          </Text>
        </Box>
      )}

      {/* ── Multi-line input ───────────────────────────────── */}
      <Box
        paddingX={1}
        paddingY={0}
        borderStyle="single"
        borderColor="grey"
        flexDirection="column"
      >
        {lines.length === 0 ? (
          <Box flexDirection="row">
            <Box marginRight={1}>
              <Text color={CURSOR_COLOR} bold>{'❯'}</Text>
            </Box>
            <Box flexGrow={1}>
              {!isStreaming ? (
                <Text backgroundColor={CURSOR_COLOR}> </Text>
              ) : null}
            </Box>
          </Box>
        ) : (
          lines.map((line, i) => (
            <Box key={i} flexDirection="row">
              <Box marginRight={1}>
                {i === 0 ? (
                  <Text color={CURSOR_COLOR} bold>{'❯'}</Text>
                ) : (
                  <Text> </Text>
                )}
              </Box>
              <Box flexGrow={1}>
                {i === cursorLine ? (
                  <Text>
                    {line.slice(0, cursorCol)}
                    {!isStreaming && line[cursorCol] ? (
                      <Text backgroundColor={CURSOR_COLOR} color="black">{line[cursorCol]}</Text>
                    ) : !isStreaming ? (
                      <Text backgroundColor={CURSOR_COLOR}> </Text>
                    ) : null}
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
}
