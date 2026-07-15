import { useState, useEffect, useRef } from 'react';
import { Box, Text } from '@coderix/ink';

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
      <Text color={barColor}>{'█'.repeat(filled)}</Text>
      <Text dimColor>{'░'.repeat(empty)}</Text>
      <Text dimColor> {pct}%</Text>
    </Text>
  );
}

/**
 * Bottom status bar showing:
 *   Ready | ctx [████░░░░] 40% 3.2K/128K | 0.0042 $ | 12m 34s | ⏲ 3s | Model: xxx ✓ | Mem 30M | Procs 4 | Ctrl+C to exit
 *
 * ctx = cache_read + cache_creation + output + input (real API tokens).
 * Mem = total RSS memory of Coderix process tree (main + sub-agents + tool subprocesses).
 * Procs = number of processes in the tree.
 * Timers update every second in real-time.
 */
export function StatusBar({ model, statusPhase, isFrozen, error, totalChars, inputTokens, outputTokens, realUsage, accumulatedCost, currency, maxContext, compactThreshold, processMemory, processCount }: StatusBarProps) {
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

  const Sep = () => <Text dimColor color="ansi:blackBright"> │ </Text>;

  return (
    <Box paddingX={1} flexDirection="row">
      {error ? (
        <Text color="ansi:red">⚠ {error}</Text>
      ) : isFrozen ? (
        <Text color="ansi:yellow">⏸ Paused</Text>
      ) : statusPhase === 'busy' ? (
        <Text color="ansi:red">◉ Busy</Text>
      ) : statusPhase === 'wait' ? (
        <Text color="ansi:yellow">◎ Wait</Text>
      ) : (
        <Text color="ansi:green">○ Idle</Text>
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
        <Text dimColor>Model: </Text>
        <Text color="ansi:magenta" bold>{model}</Text>
      </Text>

      <Sep />

      <Text>
        <Text dimColor>Mem </Text>
        <Text color="ansi:cyan">{formatMemory(processMemory)}</Text>
      </Text>

      <Sep />

      <Text>
        <Text dimColor>Procs </Text>
        <Text color="ansi:cyan">{processCount}</Text>
      </Text>

      <Sep />

      <Text dimColor>Ctrl+C to exit</Text>
    </Box>
  );
}
