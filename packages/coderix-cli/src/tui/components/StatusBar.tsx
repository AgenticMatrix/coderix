import { useState, useEffect, useRef, memo } from 'react';
import {
  Box,
  Text,
  VERTICAL_SEPARATOR,
  GAUGE_FILLED,
  GAUGE_EMPTY,
} from '@coderix/tui';

import type { TokenUsage } from '../../types.js';

interface StatusBarProps {
  model: string;
  /** Current activity phase: busy (main agent streaming/thinking/executing),
   *  wait (sub-agents or background tools running), idle (nothing active). */
  statusPhase: 'busy' | 'wait' | 'idle';
  isFrozen?: boolean;
  error: string | null;
  /** Total character count of all messages (for context estimation). */
  totalChars: number;
  /** Estimated input tokens (user messages). */
  inputTokens: number;
  /** Estimated output tokens (assistant messages). */
  outputTokens: number;
  /** Real token usage from latest API response (for ctx display). */
  realUsage: TokenUsage;
  /** Accumulated total cost across all turns. */
  accumulatedCost: number;
  /** Currency symbol (default: $). */
  currency?: string;
  /** Maximum context window size in tokens (default: 131072). */
  maxContext?: number;
  /** Auto-compact threshold ratio (0–1). Shows "X% until compact" warning. */
  compactThreshold?: number;
  /** When true, show "Press Ctrl+C again to exit" double-press hint. */
  exitHint?: boolean;
  /** Total RSS memory of the process tree in bytes. */
  processMemory: number;
  /** Number of processes in the tree. */
  processCount: number;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return Math.round(n / 1_000_000) + 'M';
  if (n >= 1000) return Math.round(n / 1000) + 'K';
  return (n / 1000).toFixed(1) + 'K';
}

/** Rough token estimate: ~4 characters per token. */
function estimateTokens(charCount: number): number {
  return Math.ceil(charCount / 4);
}

function currencySymbol(currency?: string): string {
  if (currency === 'CNY') return '¥';
  if (currency === 'USD') return '$';
  return currency ?? '$';
}

/** Format accumulated cost in dollars. */
function formatCost(cost: number): string {
  const fixed = cost.toFixed(4);
  const stripped = fixed.replace(/\.?0+$/, '').replace(/\.?0+$/, '');
  return stripped || '0';
}

/** Format seconds into a readable duration. */
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m ${s}s`;
}

/** Format RSS bytes into a readable size. */
function formatMemory(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return (mb / 1024).toFixed(1) + 'G';
  return Math.round(mb) + 'M';
}

/**
 * Render a battery-like bar for context usage.
 * Uses real API token counts (including cache) for the ctx total.
 *
 * The bar glyphs must be single-column in every terminal — this row is
 * repainted every second, and a glyph the terminal renders wider than ink
 * measured would wrap the row and strand the previous frame on screen.
 */
function ContextBar({ used, max }: { used: number; max: number }) {
  const barWidth = 8;
  const ratio = Math.min(used / max, 1);
  const filled = Math.round(ratio * barWidth);
  const empty = barWidth - filled;
  const pct = Math.round(ratio * 100);

  const barColor = ratio > 0.9 ? 'ansi:red' : ratio > 0.7 ? 'ansi:yellow' : 'ansi:green';

  return (
    <Text>
      <Text color={barColor}>{GAUGE_FILLED.repeat(filled)}</Text>
      <Text dimColor>{GAUGE_EMPTY.repeat(empty)}</Text>
      <Text dimColor> {pct}%</Text>
    </Text>
  );
}

/**
 * Bottom status bar showing:
 *   ◉ busy ╎ ctx ▰▰▰▰░░░░ 40% 3.2K/128K ╎ 0.0042$ ╎ 12m 34s ╎ ⏲ 3s ╎
 *   model: xxx ╎ mem 30M ╎ procs 4 ╎ ctrl+C to interrupt
 *
 * ctx = cache_read + cache_creation + output + input (real API tokens).
 * Mem = total RSS memory of Coderix process tree (main + sub-agents + tool subprocesses).
 * Procs = number of processes in the tree.
 * Timers update every second in real-time.
 *
 * IMPORTANT: every glyph on this row must occupy exactly one column in every
 * terminal. This row is repainted once per second in place, so a glyph that the
 * terminal draws wider than ink measured makes the row soft-wrap; ink then
 * rewinds the cursor by too few rows and the previous bar is never erased,
 * producing a stack of stale status bars. Take new glyphs from
 * `safe-glyphs.ts`, never from the ambiguous-width box-drawing block.
 */
export const StatusBar = memo(function StatusBar({ model, statusPhase, isFrozen, error, totalChars, inputTokens, outputTokens, realUsage, accumulatedCost, currency, maxContext, compactThreshold, exitHint, processMemory, processCount }: StatusBarProps) {
  const sessionStartRef = useRef(Date.now());
  const [sessionSeconds, setSessionSeconds] = useState(0);
  const [responseSeconds, setResponseSeconds] = useState(0);
  const streamStartRef = useRef<number | null>(null);

  const isStreaming = statusPhase === 'busy';

  // Track turn start/stop
  useEffect(() => {
    if (isStreaming && streamStartRef.current === null) {
      streamStartRef.current = Date.now();
      setResponseSeconds(0);
    } else if (!isStreaming) {
      streamStartRef.current = null;
      setResponseSeconds(0);
    }
  }, [isStreaming]);

  // Tick timer ONLY during active turn
  useEffect(() => {
    if (!isStreaming) return;

    const id = setInterval(() => {
      setSessionSeconds(
        Math.floor((Date.now() - sessionStartRef.current) / 1000),
      );
      if (streamStartRef.current !== null) {
        setResponseSeconds(
          Math.floor((Date.now() - streamStartRef.current) / 1000),
        );
      }
    }, 1000);
    return () => clearInterval(id);
  }, [isStreaming]);

  // ctx = output + input + cache_read (real API tokens, excluding cache_creation which is billed but not in input context)
  const ctxTokens =
    realUsage.outputTokens +
    realUsage.inputTokens +
    realUsage.cacheReadInputTokens;

  const contextMax = maxContext ?? 131072;

  // Distance to auto-compact threshold (%) — shown when approaching
  const compactDistance = ctxTokens > 0 && compactThreshold
    ? Math.max(0, Math.round(compactThreshold * 100) - Math.round((ctxTokens / contextMax) * 100))
    : null;

  // Phase markers. ◉ (U+25C9), ⏸, ⚠ and ⏲ are East Asian Neutral — 1 column
  // everywhere — so they are used directly. The circle glyphs that would
  // naturally pair with ◉, namely ◎ (U+25CE) and ○ (U+25CB), are Ambiguous and
  // would render 2 columns wide in a CJK-locale terminal, wrapping this row and
  // leaving the previous status bar stranded on screen. ◍ and ◌ are the Neutral
  // members of the same circle family.
  const PHASE_WAIT = '◍'; // ◍ CIRCLE WITH VERTICAL FILL (Neutral)
  const PHASE_IDLE = '◌'; // ◌ DOTTED CIRCLE (Neutral)

  const Sep = () => (
    <Text dimColor color="ansi:blackBright">{` ${VERTICAL_SEPARATOR} `}</Text>
  );

  return (
    <Box paddingX={1} flexDirection="row">
      {error ? (
        <Text color="ansi:red">⚠ {error}</Text>
      ) : isFrozen ? (
        <Text color="ansi:yellow">⏸ paused</Text>
      ) : statusPhase === 'busy' ? (
        <Text color="ansi:red">◉ busy</Text>
      ) : statusPhase === 'wait' ? (
        <Text color="ansi:yellow">{PHASE_WAIT} wait</Text>
      ) : (
        <Text color="ansi:green">{PHASE_IDLE} idle</Text>
      )}

      <Sep />

      <Text dimColor>ctx </Text>
      <ContextBar used={ctxTokens} max={contextMax} />
      <Text dimColor> {formatTokens(ctxTokens)}/{formatTokens(contextMax)}</Text>
      {compactDistance !== null && compactDistance <= 10 && (
        <Text dimColor color="ansi:yellow">
          {' '}({compactDistance}% until compact)
        </Text>
      )}

      <Sep />

      <Text dimColor>
        {formatCost(accumulatedCost)}{currencySymbol(currency)}
      </Text>

      <Sep />

      <Text dimColor>{formatDuration(sessionSeconds)}</Text>

      <Sep />

      {statusPhase !== 'idle' ? (
        <Text color="ansi:yellow">⏲ {formatDuration(responseSeconds)}</Text>
      ) : (
        <Text dimColor>⏲ 0s</Text>
      )}

      <Sep />

      <Text>
        <Text dimColor>model: </Text>
        <Text color="ansi:magenta" bold>{model}</Text>
      </Text>

      <Sep />

      <Text>
        <Text dimColor>mem </Text>
        <Text color="ansi:cyan">{formatMemory(processMemory)}</Text>
      </Text>

      <Sep />

      <Text>
        <Text dimColor>procs </Text>
        <Text color="ansi:cyan">{processCount}</Text>
      </Text>

      <Sep />

      {exitHint ? (
        <Text color="ansi:yellow">Press ctrl+C again to exit</Text>
      ) : statusPhase === 'idle' ? (
        <Text dimColor>ctrl+C to exit</Text>
      ) : (
        <Text dimColor>ctrl+C to interrupt</Text>
      )}
    </Box>
  );
});
