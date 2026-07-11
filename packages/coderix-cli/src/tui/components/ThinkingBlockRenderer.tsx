import { Box, Text } from 'ink';
import { useState, useEffect } from 'react';

const SPINNER_FRAMES = ['·', '✢', '✱', '✶', '✻', '✽'];

function SpinnerGlyph({ active }: { active: boolean }) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 120);
    return () => clearInterval(id);
  }, [active]);

  return (
    <Box width={2} flexShrink={0}>
      <Text bold color="#A855F7">
        {active ? SPINNER_FRAMES[frame]! : '✻'}
      </Text>
    </Box>
  );
}

function formatTime(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(0)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.floor(s % 60);
  return `${m}m ${rs}s`;
}

function formatTokens(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

interface ThinkingBlockRendererProps {
  content: string;
  thinkingExpanded?: boolean;
  thinkingDuration?: number;
  thinkingTokens?: number;
  /** Cumulative output tokens since the last user message. */
  turnOutputTokens?: number;
}

/**
 * Thinking block renderer with ActivityLine-style header.
 *   ✽ Thinking… (20s · ↓ 743 tokens)
 *   ✽ Thought (12s · ↑ 1.2k tokens)
 */
export function ThinkingBlockRenderer({ content, thinkingExpanded, thinkingDuration, thinkingTokens, turnOutputTokens }: ThinkingBlockRendererProps) {
  const isThoughtDone = thinkingDuration != null;
  const thinkingLines = content.split('\n');
  const tooLong = thinkingLines.length > 2;
  const collapsed = tooLong && !thinkingExpanded;
  const logicalLines = collapsed
    ? thinkingLines.slice(0, 2)
    : thinkingLines;

  const label = isThoughtDone ? 'Thought' : 'Thinking';
  const showTokens = turnOutputTokens ?? thinkingTokens ?? 0;
  const tokenStr = formatTokens(showTokens);
  const timeStr = isThoughtDone ? formatTime(thinkingDuration!) : '...';
  const arrow = isThoughtDone ? '↑' : '↓';

  return (
    <Box flexDirection="row" marginBottom={1}>
      <SpinnerGlyph active={!isThoughtDone} />
      <Box flexDirection="column" flexGrow={1}>
        <Text>
          <Text color="#A855F7">{label}…</Text>
          <Text dimColor> ({timeStr} · {arrow} {tokenStr} tokens)</Text>
        </Text>
        <Box paddingLeft={2} flexDirection="column">
          {logicalLines.map((line, i) => (
            <Text key={i} dimColor color="grey">{line || ' '}</Text>
          ))}
          {collapsed ? (
            <Text dimColor color="grey">{`... ${thinkingLines.length - 2} more lines (Ctrl+D to detail)`}</Text>
          ) : null}
          {tooLong && thinkingExpanded ? (
            <Text dimColor color="grey">{'(Ctrl+D to detail)'}</Text>
          ) : null}
        </Box>
      </Box>
    </Box>
  );
}
