import { describe, it, expect } from 'vitest';
import type { AggregatedTokenUsage, ChatMessage } from '../../../store/types.js';
import {
  billedInputTokens,
  totalBillableTokens,
  formatCacheHitPercent,
  cacheHitPercent,
  formatExactTokens,
  formatCompactTokens,
  formatStatDuration,
  deriveSessionStats,
} from '../status-stats.js';

function usage(overrides: Partial<AggregatedTokenUsage> = {}): AggregatedTokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalCost: 0,
    currency: 'USD',
    contextTokens: 0,
    ...overrides,
  };
}

function message(
  role: ChatMessage['role'],
  timestamp: number,
  toolCalls = 0,
): ChatMessage {
  return {
    id: `${role}-${timestamp}`,
    role,
    content: '',
    timestamp,
    blocks: [
      { type: 'text', content: 'hi' },
      ...Array.from({ length: toolCalls }, (_, i) => ({
        type: 'tool_use' as const,
        toolId: `t${i}`,
        toolName: 'Read',
      })),
    ],
  };
}

describe('billedInputTokens', () => {
  it('sums the three disjoint prompt buckets', () => {
    expect(billedInputTokens(usage({ inputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 20 }))).toBe(1020);
  });

  it('excludes output tokens', () => {
    expect(billedInputTokens(usage({ inputTokens: 100, outputTokens: 50 }))).toBe(100);
  });
});

describe('totalBillableTokens', () => {
  it('adds output on top of the prompt buckets', () => {
    expect(totalBillableTokens(usage({ inputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 20, outputTokens: 80 }))).toBe(1100);
  });
});

describe('formatCacheHitPercent', () => {
  it('returns null without prompt input', () => {
    expect(formatCacheHitPercent(0, 0)).toBeNull();
  });

  it('reports a zero hit rate', () => {
    expect(formatCacheHitPercent(0, 1000)).toBe('0');
  });

  it('reports a full hit', () => {
    expect(formatCacheHitPercent(1000, 1000)).toBe('100');
  });

  it('never truncates a partial hit into 100', () => {
    expect(formatCacheHitPercent(999, 1000, 0)).toBe('99');
    expect(formatCacheHitPercent(999, 1000, 1)).toBe('99.9');
    expect(formatCacheHitPercent(9999, 10_000, 1)).toBe('99.9');
  });

  it('truncates instead of rounding up', () => {
    expect(formatCacheHitPercent(2, 3, 1)).toBe('66.6');
  });

  it('clamps nonsense values', () => {
    expect(formatCacheHitPercent(2000, 1000)).toBe('100');
    expect(formatCacheHitPercent(-5, 1000)).toBe('0');
    expect(formatCacheHitPercent(10, -1)).toBeNull();
  });
});

describe('cacheHitPercent', () => {
  it('uses the prompt buckets as the denominator', () => {
    const value = usage({ inputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 0, outputTokens: 500 });
    expect(cacheHitPercent(value)).toBe('90');
  });

  it('returns null for a session without prompt input', () => {
    expect(cacheHitPercent(usage({ outputTokens: 12 }))).toBeNull();
  });
});

describe('formatExactTokens', () => {
  it('groups thousands', () => {
    expect(formatExactTokens(0)).toBe('0');
    expect(formatExactTokens(517)).toBe('517');
    expect(formatExactTokens(1234)).toBe('1,234');
    expect(formatExactTokens(1234567)).toBe('1,234,567');
  });
});

describe('formatCompactTokens', () => {
  it('keeps sub-thousand counts exact', () => {
    expect(formatCompactTokens(0)).toBe('0');
    expect(formatCompactTokens(517)).toBe('517');
  });

  it('abbreviates thousands and millions', () => {
    expect(formatCompactTokens(1000)).toBe('1K');
    expect(formatCompactTokens(1234)).toBe('1.2K');
    expect(formatCompactTokens(517_000)).toBe('517K');
    expect(formatCompactTokens(1_234_567)).toBe('1.2M');
  });

  it('promotes 999.5K+ to millions instead of printing 1000K', () => {
    expect(formatCompactTokens(999_499)).toBe('999K');
    expect(formatCompactTokens(999_500)).toBe('1M');
    expect(formatCompactTokens(999_999)).toBe('1M');
  });
});

describe('formatStatDuration', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatStatDuration(0)).toBe('0s');
    expect(formatStatDuration(45.9)).toBe('45s');
    expect(formatStatDuration(162)).toBe('2m 42s');
    expect(formatStatDuration(3780)).toBe('1h 3m');
  });

  it('clamps negative input', () => {
    expect(formatStatDuration(-3)).toBe('0s');
  });
});

describe('deriveSessionStats', () => {
  it('returns zeroes for an empty transcript', () => {
    expect(deriveSessionStats([])).toEqual({ turns: 0, steps: 0, toolCalls: 0, startedAt: null });
  });

  it('counts turns, model steps and tool calls', () => {
    const stats = deriveSessionStats([
      message('user', 1000),
      message('assistant', 1100, 2),
      message('user', 2000),
      message('assistant', 2100, 1),
    ]);
    expect(stats).toEqual({ turns: 2, steps: 2, toolCalls: 3, startedAt: 1000 });
  });

  it('uses the oldest message timestamp even when out of order', () => {
    const stats = deriveSessionStats([
      message('user', 5000),
      message('assistant', 3000),
    ]);
    expect(stats.startedAt).toBe(3000);
  });

  it('ignores system messages for the turn/step counts', () => {
    const stats = deriveSessionStats([message('system', 100), message('user', 200)]);
    expect(stats.turns).toBe(1);
    expect(stats.steps).toBe(0);
  });
});
