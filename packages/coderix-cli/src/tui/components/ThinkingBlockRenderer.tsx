import { Box, Text } from 'ink';
import { useState, useEffect } from 'react';

const SPINNER_FRAMES = ['·', '✢', '✱', '✶', '✻', '✽'];

export type ActivityPhase = 'idle' | 'thinking' | 'executing' | 'streaming';

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

/**
 * Shimmer text — a subtle wave highlight sweeps through the characters.
 * All characters remain visible at the base color; the wave adds a gentle
 * brightness boost without replacing characters with white.
 */
export function ShimmerText({ text, color = '#FFFFFF', active = true }: { text: string; color?: string; active?: boolean }) {
  const [pos, setPos] = useState(0);
  const chars = text.split('');

  useEffect(() => {
    if (!active || chars.length < 2) return;
    const id = setInterval(() => setPos((p) => (p + 1) % (chars.length * 2)), 120);
    return () => clearInterval(id);
  }, [active, chars.length]);

  if (!active) return <Text color={color}>{text}</Text>;

  return (
    <Text>
      {chars.map((ch, i) => {
        const dist = Math.min(Math.abs(i - pos), Math.abs(i - pos - chars.length * 2), Math.abs(i - pos + chars.length * 2));
        if (dist === 0) return <Text key={i} bold color={color}>{ch}</Text>;
        return <Text key={i} color={color}>{ch}</Text>;
      })}
    </Text>
  );
}

const PHASE_NAMES: Record<ActivityPhase, string> = {
  idle: '',
  thinking: 'Thinking',
  executing: 'Executing',
  streaming: 'Streaming',
};

export interface ActivityLineProps {
  phase: ActivityPhase;
  /** Elapsed ms since the turn started. */
  turnElapsed: number;
  /** Cumulative output tokens this turn (main + sub-agents via EventBus). */
  turnOutputTokens: number;
}

/**
 * Activity line in Claude Code style:
 *   ✽ Thinking… (20s · ↓ 743 tokens)
 *   ✽ Executing… (53s · ↓ 898 tokens)
 *   ✽ Streaming… (25s · ↑ 1.2k tokens)
 */
export function ActivityLine({ phase, turnElapsed, turnOutputTokens }: ActivityLineProps) {
  if (phase === 'idle') return null;

  const timeStr = formatTime(turnElapsed);
  const phaseName = PHASE_NAMES[phase];
  const tokenStr = formatTokens(turnOutputTokens);
  const arrow = phase === 'streaming' ? '↑' : '↓';

  return (
    <Box flexDirection="row" marginBottom={1}>
      <SpinnerGlyph active={true} />
      <Box flexDirection="column" flexGrow={1}>
        <Text>
          <ShimmerText text={`${phaseName}…`} active={phase === 'thinking'} color="#A855F7" />
          <Text dimColor> ({timeStr} · {arrow} {tokenStr} tokens)</Text>
        </Text>
      </Box>
    </Box>
  );
}

// ── Backward-compatible ThinkingBlockRenderer ──────────────────────────

interface ThinkingBlockRendererProps {
  content: string;
  thinkingExpanded?: boolean;
  thinkingDuration?: number;
  thinkingTokens?: number;
}

/**
 * @deprecated Use ActivityLine instead.
 * Standalone thinking block renderer kept for backward compatibility.
 */
export function ThinkingBlockRenderer({ content, thinkingExpanded, thinkingDuration, thinkingTokens }: ThinkingBlockRendererProps) {
  const isThoughtDone = thinkingDuration != null;
  const thinkingLines = content.split('\n');
  const tooLong = thinkingLines.length > 2;
  const collapsed = tooLong && !thinkingExpanded;
  const logicalLines = collapsed
    ? thinkingLines.slice(0, 2)
    : thinkingLines;

  return (
    <Box flexDirection="row" marginBottom={1}>
      <Box flexDirection="column" flexGrow={1}>
        <Box paddingLeft={0} flexDirection="column">
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
