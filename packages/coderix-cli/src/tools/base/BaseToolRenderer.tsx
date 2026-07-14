import { Box, Text } from '@coderix/ink';
import type { Color } from '@coderix/ink';
import type { ToolUseRendererProps } from '../types.js';
import { useToolTimer } from '../shared/useToolTimer.js';

const STATE_ICON: Record<string, string> = {
  done: '●',
  error: '❌',
};

const RISK_COLOR: Record<string, string> = {
  safe: 'ansi:green',
  mutation: 'ansi:yellow',
  destructive: 'ansi:red',
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Common base for all tool-use renderers.
 *
 * Renders a colour-coded card with:
 *  - status icon + tool icon + tool name + parameter summary
 *  - duration badge
 *  - permission state tag
 *  - collapsible body (children)
 */
export function BaseToolRenderer({
  toolName,
  paramSummary,
  state,
  riskLevel,
  permissionState,
  duration,
  expanded = true,
  children,
}: ToolUseRendererProps) {
  const borderColor = (riskLevel ? RISK_COLOR[riskLevel] : 'ansi:blackBright') as Color;
  const isExecuting = state === 'executing';
  const isPending = state === 'pending';
  const isDone = state === 'done';

  const { elapsedSecs, blinkOn } = useToolTimer(isExecuting || isPending);

  const active = isExecuting || isPending;
  const statusIcon = active
    ? (blinkOn ? '●' : '○')
    : STATE_ICON[state];
  const statusColor = (active ? 'ansi:yellow' : isDone ? 'ansi:green' : state === 'error' ? 'ansi:red' : 'ansi:blackBright') as Color;

  return (
    <Box flexDirection="row" marginBottom={1}>
      {/* Icon column */}
      <Box width={2} flexShrink={0}>
        <Text color={statusColor}>{statusIcon}</Text>
      </Box>

      {/* Content */}
      <Box flexDirection="column" flexGrow={1}>
        {/* Title bar */}
        <Box flexDirection="row" justifyContent="space-between">
          <Box marginRight={1}>
            <Text>
              <Text bold color={borderColor}>
                {toolName}
              </Text>
              {paramSummary ? (
                <Text dimColor> · {paramSummary}</Text>
              ) : null}
              {(isExecuting || isPending) ? (
                <Text dimColor color="ansi:yellow"> {isExecuting ? 'running' : 'pending'} {elapsedSecs}s</Text>
              ) : null}
            </Text>
          </Box>

          <Box>
            {duration !== undefined && isDone ? (
              <Text dimColor>⏱ {formatDuration(duration)}</Text>
            ) : isDone ? (
              <Text dimColor>{elapsedSecs}s</Text>
            ) : null}
            {permissionState === 'denied' ? (
              <Text color="ansi:red"> ⛔ denied</Text>
            ) : permissionState === 'pending' ? (
              <Text color="ansi:yellow"> ⚠ pending</Text>
            ) : null}
          </Box>
        </Box>

        {/* Body */}
        {expanded && children ? (
          <Box paddingLeft={2} flexDirection="column" marginTop={0}>
            {children}
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}
