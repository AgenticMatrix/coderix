import { Box, Text } from 'ink';
import { BaseToolRenderer } from '../base/BaseToolRenderer.js';
import type { ToolUseRendererProps } from '../types.js';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function WebFetchRenderer(props: ToolUseRendererProps) {
  const metadata = props.result?.metadata;
  const byteLength = metadata?.byteLength as number | undefined;
  const contentType = metadata?.contentType as string | undefined;

  return (
    <BaseToolRenderer {...props}>
      {byteLength !== undefined ? (
        <Box flexDirection="column">
          <Text>
            <Text dimColor>Size: </Text>
            <Text>{formatBytes(byteLength)}</Text>
            {contentType ? (
              <>
                <Text dimColor> · Type: </Text>
                <Text>{contentType}</Text>
              </>
            ) : null}
          </Text>
        </Box>
      ) : null}
    </BaseToolRenderer>
  );
}
