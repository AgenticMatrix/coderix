import { Box, Text } from 'ink';
import type { ToolUseRendererProps } from '../types.js';
import { useToolTimer } from '../shared/useToolTimer.js';

const STATE_ICON: Record<string, string> = {
  pending: '⬜',
  executing: '●',
  done: '●',
  error: '❌',
};

const RISK_COLOR: Record<string, string> = {
  safe: 'green',
  mutation: 'yellow',
  destructive: 'red',
};

const TOOL_ICONS: Record<string, string> = {
  read: '📖',
  write: '✏️',
  edit: '✏️',
  bash: '⚡',
  glob: '🔍',
  grep: '🔎',
  'web-fetch': '🌐',
  'web-search': '🔎',
  'TodoWrite': '📋',
  'task-create': '📝',
  'task-update': '📝',
  'Agent': '🧭',
  'TaskStop': '🛑',
  'SendMessage': '💬',
  'Sleep': '😴',
  skill: '⚡',
  cron: '⏰',
  lsp: '🔍',
  default: '🔧',
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
  const borderColor = riskLevel ? RISK_COLOR[riskLevel] : 'grey';
  const icon = TOOL_ICONS[toolName] ?? TOOL_ICONS.default;
  const isExecuting = state === 'executing';
  const isDone = state === 'done';

  const { elapsedSecs, blinkOn } = useToolTimer(isExecuting);

  const statusIcon = isExecuting
    ? (blinkOn ? '●' : '○')
    : STATE_ICON[state];
  const statusColor = isExecuting ? 'yellow' : isDone ? 'green' : state === 'error' ? 'red' : 'grey';

  return (
    <Box
      flexDirection="column"
      marginBottom={1}
    >
      {/* Title bar */}
      <Box flexDirection="row" justifyContent="space-between">
        <Box marginRight={1}>
          <Text>
            <Text color={statusColor}>{statusIcon} </Text>
            <Text bold color={borderColor}>
              {icon} {toolName}
            </Text>
            {paramSummary ? (
              <Text dimColor> · {paramSummary}</Text>
            ) : null}
            {isExecuting ? (
              <Text dimColor color="yellow"> running {elapsedSecs}s</Text>
            ) : null}
            {state === 'pending' ? (
              <Text dimColor> (pending)</Text>
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
            <Text color="red"> ⛔ denied</Text>
          ) : permissionState === 'pending' ? (
            <Text color="yellow"> ⚠ pending</Text>
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
  );
}
