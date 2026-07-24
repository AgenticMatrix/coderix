import React from 'react';
import { Box, Text } from '@coderix/ink';
import { BaseToolRenderer } from '../base/BaseToolRenderer.js';
import type { ToolUseRendererProps } from '../types.js';

function buildSummary(input: Record<string, unknown>): string {
  const parts: string[] = [];
  const name = input.name as string | undefined;
  const teamName = input.team_name as string | undefined;
  const desc = input.description as string | undefined;
  if (desc) parts.push(desc);
  if (name) parts.push(name);
  if (teamName) parts.push(teamName);
  return parts.length > 0 ? `(${parts.join(', ')})` : '';
}

/**
 * TeamAgent tool-use renderer.
 *
 * Renders:
 *   ● TeamAgent(description, team_name, name)  1.2s
 *     └ <prompt first line or full prompt when expanded>
 *       ... N more lines, Ctrl+D to detail
 *
 * Ctrl+D toggles prompt expansion via contentExpanded.
 * The separate tool_result block is suppressed via TeamAgentResultRenderer.
 */
export function TeamAgentRenderer(props: ToolUseRendererProps): React.ReactNode {
  const prompt = props.input.prompt as string | undefined;
  const promptLines = prompt ? prompt.split('\n') : [];
  const expanded = props.contentExpanded;
  const displayLines = expanded ? promptLines : promptLines.slice(0, 1);
  const hidden = promptLines.length - displayLines.length;

  const summary = buildSummary(props.input);
  const fullName = summary ? `TeamAgent${summary}` : 'TeamAgent';

  return (
    <BaseToolRenderer {...props} toolName={fullName} paramSummary="">
      {displayLines.length > 0 ? (
        <Box flexDirection="column">
          {displayLines.map((line, i) => (
            <Text key={i} dimColor>{i === 0 ? '└ ' : '  '}{line.length > 120 ? line.slice(0, 117) + '...' : line}</Text>
          ))}
          {hidden > 0 ? (
            <Text dimColor>  ... {hidden} more lines, Ctrl+D to detail</Text>
          ) : null}
        </Box>
      ) : null}
    </BaseToolRenderer>
  );
}
