import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyToolResultLimits,
  DEFAULT_MAX_RESULT_SIZE_CHARS,
  MAX_TOOL_RESULTS_PER_MESSAGE_CHARS,
  TOOL_RESULTS_DIR,
} from '../../src/core/tool-result-limiter.js';
import type { ToolResultBlock } from '../../src/core/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(
  toolUseId: string,
  content: string,
  isError = false,
): ToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content,
    is_error: isError,
  };
}

function extractContent(result: ToolResultBlock): string {
  if (typeof result.content === 'string') return result.content;
  return '';
}

const PERSISTED_TAG = '<persisted-output>';

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Clean up tool results dir
  if (existsSync(TOOL_RESULTS_DIR)) {
    try {
      const files = readdirSync(TOOL_RESULTS_DIR);
      for (const f of files) {
        unlinkSync(join(TOOL_RESULTS_DIR, f));
      }
      rmdirSync(TOOL_RESULTS_DIR);
    } catch { /* ignore */ }
  }
});

afterEach(() => {
  if (existsSync(TOOL_RESULTS_DIR)) {
    try {
      const files = readdirSync(TOOL_RESULTS_DIR);
      for (const f of files) {
        unlinkSync(join(TOOL_RESULTS_DIR, f));
      }
      rmdirSync(TOOL_RESULTS_DIR);
    } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// Empty result marker
// ---------------------------------------------------------------------------

describe('empty result marker', () => {
  it('should inject placeholder for empty string content', () => {
    const results = [makeResult('tu_1', '')];
    const processed = applyToolResultLimits(results, ['bash']);
    expect(extractContent(processed[0]!)).toBe('(bash completed with no output)');
  });

  it('should inject placeholder for whitespace-only content', () => {
    const results = [makeResult('tu_1', '   \n  ')];
    const processed = applyToolResultLimits(results, ['bash']);
    expect(extractContent(processed[0]!)).toBe('(bash completed with no output)');
  });

  it('should inject placeholder for empty array content', () => {
    const result: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: 'tu_1',
      content: [],
    };
    const processed = applyToolResultLimits([result], ['bash']);
    expect(extractContent(processed[0]!)).toBe('(bash completed with no output)');
  });

  it('should not inject placeholder for non-empty content', () => {
    const results = [makeResult('tu_1', 'some output')];
    const processed = applyToolResultLimits(results, ['bash']);
    expect(extractContent(processed[0]!)).toBe('some output');
  });
});

// ---------------------------------------------------------------------------
// Per-result size limit
// ---------------------------------------------------------------------------

describe('per-result size limit', () => {
  it('should not modify results under the limit', () => {
    const results = [makeResult('tu_1', 'small output')];
    const processed = applyToolResultLimits(results, ['read']);
    expect(extractContent(processed[0]!)).toBe('small output');
  });

  it('should persist results over the default limit', () => {
    // Create content larger than DEFAULT_MAX_RESULT_SIZE_CHARS
    const largeContent = 'x'.repeat(DEFAULT_MAX_RESULT_SIZE_CHARS + 100);
    const results = [makeResult('tu_large', largeContent)];
    const processed = applyToolResultLimits(results, ['read']);

    const output = extractContent(processed[0]!);
    expect(output).toContain(PERSISTED_TAG);
    expect(output).toContain('Output too large');
    expect(output.length).toBeLessThan(largeContent.length);
  });

  it('should respect tool-specific maxResultSizeChars', () => {
    const smallMax = 100;
    const largeContent = 'x'.repeat(200);

    const results = [makeResult('tu_1', largeContent)];
    const toolSizeMap = new Map([['read', smallMax]]);
    const processed = applyToolResultLimits(results, ['read'], toolSizeMap);

    const output = extractContent(processed[0]!);
    expect(output).toContain(PERSISTED_TAG);
  });

  it('should not persist when maxResultSizeChars is Infinity', () => {
    const largeContent = 'x'.repeat(DEFAULT_MAX_RESULT_SIZE_CHARS + 100);
    const results = [makeResult('tu_1', largeContent)];
    const toolSizeMap = new Map([['read', Infinity]]);
    const processed = applyToolResultLimits(results, ['read'], toolSizeMap);

    expect(extractContent(processed[0]!)).toBe(largeContent);
  });
});

// ---------------------------------------------------------------------------
// Aggregate budget
// ---------------------------------------------------------------------------

describe('aggregate per-message budget', () => {
  it('should not modify results under aggregate limit', () => {
    const results = [
      makeResult('tu_1', 'a'.repeat(1000)),
      makeResult('tu_2', 'b'.repeat(1000)),
    ];
    const processed = applyToolResultLimits(results, ['read', 'write']);
    expect(processed).toHaveLength(2);
    // Both should be unchanged
    expect(extractContent(processed[0]!)).toBe('a'.repeat(1000));
    expect(extractContent(processed[1]!)).toBe('b'.repeat(1000));
  });

  it('should persist the largest results when aggregate limit exceeded', () => {
    // Two large results that together exceed MAX_TOOL_RESULTS_PER_MESSAGE_CHARS
    const half = Math.floor(MAX_TOOL_RESULTS_PER_MESSAGE_CHARS / 2) + 1000;
    const results = [
      makeResult('tu_1', 'a'.repeat(half)),
      makeResult('tu_2', 'b'.repeat(half)),
    ];
    const processed = applyToolResultLimits(results, ['read', 'write']);

    // At least one result should be persisted (the largest one(s))
    const persisted = processed.filter((r) =>
      extractContent(r).includes(PERSISTED_TAG),
    );
    expect(persisted.length).toBeGreaterThan(0);
  });

  it('should not re-persist already compacted results', () => {
    // Already-compacted result + another that pushes over budget
    // The already-compacted one should be skipped in candidate selection
    const alreadyCompacted = makeResult(
      'tu_1',
      '<persisted-output>\nOutput too large (100KB). Full output saved to: /tmp/test.txt\n\nPreview (first 2KB):\n...\n</persisted-output>',
    );
    const largeResult = makeResult(
      'tu_2',
      'x'.repeat(MAX_TOOL_RESULTS_PER_MESSAGE_CHARS),
    );
    const results = [alreadyCompacted, largeResult];
    const processed = applyToolResultLimits(results, ['read', 'grep']);

    // The already-compacted should stay as-is
    expect(extractContent(processed[0]!)).toContain(PERSISTED_TAG);
    // The large result should be persisted
    expect(extractContent(processed[1]!)).toContain(PERSISTED_TAG);
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe('disk persistence', () => {
  it('should persist large results to disk', () => {
    const largeContent = 'x'.repeat(DEFAULT_MAX_RESULT_SIZE_CHARS + 100);
    const results = [makeResult('tu_persist_test', largeContent)];
    applyToolResultLimits(results, ['read']);

    // Check that the file was created
    expect(existsSync(TOOL_RESULTS_DIR)).toBe(true);
    const files = readdirSync(TOOL_RESULTS_DIR);
    expect(files.length).toBeGreaterThan(0);
  });

  it('should include filepath in persisted message', () => {
    const largeContent = 'x'.repeat(DEFAULT_MAX_RESULT_SIZE_CHARS + 100);
    const results = [makeResult('tu_fp_test', largeContent)];
    const processed = applyToolResultLimits(results, ['read']);

    const output = extractContent(processed[0]!);
    expect(output).toContain('Full output saved to:');
    expect(output).toContain('tu_fp_test');
  });
});
