/**
 * ApprovalPrompt — Floating permission approval UI.
 *
 * Renders when the agent wants to execute a tool that requires user
 * confirmation (mutation / destructive operations in ASK mode).
 *
 * Ported from Coderix's prompts.tsx ApprovalPrompt.
 */
import { Box, Text, useInput } from '@coderix/ink';
import { useState } from 'react';
import type { ApprovalRequest } from '../../types.js';

const OPTS = ['once', 'session', 'always', 'deny'] as const;
const LABELS: Record<string, string> = {
  once: 'Allow once',
  session: 'Allow this session',
  always: 'Always allow',
  deny: 'Deny',
};
const CMD_PREVIEW_LINES = 10;

export interface ApprovalPromptProps {
  req: ApprovalRequest;
  onChoice: (choice: string) => void;
}

export function ApprovalPrompt({ req, onChoice }: ApprovalPromptProps) {
  const [sel, setSel] = useState(0);

  useInput((_input, key) => {
    if (key.escape) {
      onChoice('deny');
      return;
    }

    // Ctrl+C denies the approval
    if (key.ctrl) {
      onChoice('deny');
      return;
    }

    if (key.return) {
      onChoice(OPTS[sel]!);
      return;
    }

    if (key.upArrow && sel > 0) {
      setSel((s) => s - 1);
      return;
    }

    if (key.downArrow && sel < OPTS.length - 1) {
      setSel((s) => s + 1);
      return;
    }

    // Number keys 1-4 quick-pick
    const n = parseInt(_input, 10);
    if (n >= 1 && n <= OPTS.length) {
      onChoice(OPTS[n - 1]!);
    }
  });

  const rawLines = req.command.split('\n');
  const shown = rawLines.slice(0, CMD_PREVIEW_LINES);
  const overflow = rawLines.length - shown.length;
  const hasCommandDetail = req.command.trim() !== req.toolName;

  return (
    <Box
      borderStyle="double"
      borderColor="ansi:yellow"
      flexDirection="column"
      paddingX={1}
    >
      <Text bold color="ansi:yellow">
        Approval required — {req.description}
      </Text>

      {hasCommandDetail ? (
        <Box flexDirection="column" paddingLeft={1}>
          {shown.map((line, i) => (
            <Text key={i} wrap="truncate-end">
              {line || ' '}
            </Text>
          ))}
          {overflow > 0 ? (
            <Text dimColor>
              ... +{overflow} more line{overflow === 1 ? '' : 's'}
            </Text>
          ) : null}
        </Box>
      ) : null}

      <Text>{' '}</Text>

      {OPTS.map((o, i) => (
        <Text key={o}>
          <Text
            bold={sel === i}
            color={sel === i ? 'ansi:yellow' : undefined}
            dimColor={sel !== i}
            inverse={sel === i}
          >
            {sel === i ? '> ' : '  '}
            {i + 1}. {LABELS[o]}
          </Text>
        </Text>
      ))}

      <Text dimColor>
        Up/Down select · Enter confirm · 1-4 quick pick · Esc/Ctrl+C deny
      </Text>
    </Box>
  );
}
