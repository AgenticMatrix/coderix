import { describe, expect, it } from 'vitest';
import {
  normalizeMessagesForAPI,
  MISSING_TOOL_RESULT_PLACEHOLDER,
} from '../../src/core/message-normalizer.js';

// ---------------------------------------------------------------------------
// Helpers to build test messages
// ---------------------------------------------------------------------------

interface TestBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | TestBlock[];
  is_error?: boolean;
}

interface TestMessage {
  role: string;
  content: string | TestBlock[];
}

// ---------------------------------------------------------------------------
// normalizeMessagesForAPI — full pipeline
// ---------------------------------------------------------------------------

describe('normalizeMessagesForAPI', () => {
  it('should filter out system messages', () => {
    const messages: TestMessage[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello' },
    ];
    const result = normalizeMessagesForAPI(messages);
    expect(result).toHaveLength(1);
    expect(result[0]!.role).toBe('user');
  });

  it('should filter empty user messages', () => {
    const messages: TestMessage[] = [
      { role: 'user', content: '' },
      { role: 'user', content: 'Hello' },
    ];
    const result = normalizeMessagesForAPI(messages);
    expect(result).toHaveLength(1);
    expect(result[0]!.role).toBe('user');
    // After normalization, merged string content becomes a block array
    const content = result[0]!.content;
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((b: TestBlock) => b.text ?? '').join('')
        : '';
    expect(text).toContain('Hello');
  });

  it('should be idempotent', () => {
    const messages: TestMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi!' },
    ];
    const first = normalizeMessagesForAPI(messages);
    const second = normalizeMessagesForAPI(first);
    expect(second).toEqual(first);
  });
});

// ---------------------------------------------------------------------------
// Merge consecutive user messages
// ---------------------------------------------------------------------------

describe('merge consecutive user messages', () => {
  it('should merge two consecutive user messages', () => {
    const messages: TestMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'user', content: 'World' },
      { role: 'assistant', content: 'Hi!' },
    ];
    const result = normalizeMessagesForAPI(messages);
    // Two user messages merged into one, then assistant = 2 messages
    expect(result).toHaveLength(2);
    expect(result[0]!.role).toBe('user');
    // Merged string content becomes block array
    expect(Array.isArray(result[0]!.content)).toBe(true);
    expect(result[1]!.role).toBe('assistant');
  });

  it('should not merge user messages separated by assistant', () => {
    const messages: TestMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi!' },
      { role: 'user', content: 'World' },
    ];
    const result = normalizeMessagesForAPI(messages);
    expect(result).toHaveLength(3);
  });

  it('should add newline between consecutive text blocks when merging', () => {
    const messages: TestMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'Part A' }] },
      { role: 'user', content: [{ type: 'text', text: 'Part B' }] },
    ];
    const result = normalizeMessagesForAPI(messages);
    expect(result).toHaveLength(1);
    const content = result[0]!.content;
    if (typeof content === 'string') {
      expect(content).toContain('Part A\nPart B');
    }
  });
});

// ---------------------------------------------------------------------------
// hoistToolResults
// ---------------------------------------------------------------------------

describe('hoist tool_results to front', () => {
  it('should move tool_result blocks before text and smoosh text sibling', () => {
    // After the full pipeline (merge→pair→hoist→smoosh), text siblings
    // are folded into the tool_result, leaving only the tool_result block.
    const messages: TestMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'read', input: {} }],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Here is the result:' },
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'output' },
        ],
      },
    ];
    const result = normalizeMessagesForAPI(messages);
    const blocks = result[1]!.content as TestBlock[];
    // After pipeline: tool_result with smooshed text content
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe('tool_result');
  });

  it('should keep multiple tool_results in order', () => {
    const messages: TestMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'read', input: {} },
          { type: 'tool_use', id: 'tu_2', name: 'grep', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Results:' },
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'A' },
          { type: 'text', text: 'More:' },
          { type: 'tool_result', tool_use_id: 'tu_2', content: 'B' },
        ],
      },
    ];
    const result = normalizeMessagesForAPI(messages);
    const blocks = result[1]!.content as TestBlock[];
    expect(blocks[0]!.type).toBe('tool_result');
    expect((blocks[0] as { tool_use_id: string }).tool_use_id).toBe('tu_1');
    expect(blocks[1]!.type).toBe('tool_result');
    expect((blocks[1] as { tool_use_id: string }).tool_use_id).toBe('tu_2');
  });
});

// ---------------------------------------------------------------------------
// smoosh text into tool_result
// ---------------------------------------------------------------------------

describe('smoosh text into tool_result', () => {
  it('should fold text sibling into tool_result.content (string content)', () => {
    const messages: TestMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'read', input: {} }],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'file output' },
          { type: 'text', text: 'system reminder text' },
        ],
      },
    ];
    const result = normalizeMessagesForAPI(messages);
    const blocks = result[1]!.content as TestBlock[];
    // Text should be smooshed into tool_result, not left as sibling
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe('tool_result');
    const content = typeof blocks[0]!.content === 'string'
      ? blocks[0]!.content
      : '';
    expect(content).toContain('file output');
    expect(content).toContain('system reminder text');
  });

  it('should fold text sibling into tool_result.content (array content)', () => {
    const messages: TestMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'read', input: {} }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_1',
            content: [{ type: 'text', text: 'structured output' }],
          },
          { type: 'text', text: 'extra context' },
        ],
      },
    ];
    const result = normalizeMessagesForAPI(messages);
    const blocks = result[1]!.content as TestBlock[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe('tool_result');
  });

  it('should smoosh text into LAST tool_result only', () => {
    const messages: TestMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'read', input: {} },
          { type: 'tool_use', id: 'tu_2', name: 'grep', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'first' },
          { type: 'tool_result', tool_use_id: 'tu_2', content: 'second' },
          { type: 'text', text: 'context' },
        ],
      },
    ];
    const result = normalizeMessagesForAPI(messages);
    const blocks = result[1]!.content as TestBlock[];
    expect(blocks).toHaveLength(2); // tu_1 remains separate
    expect(blocks[0]!.type).toBe('tool_result'); // tu_1
    expect(blocks[1]!.type).toBe('tool_result'); // tu_2 + context
    const secondContent = typeof blocks[1]!.content === 'string'
      ? blocks[1]!.content
      : '';
    expect(secondContent).toContain('second');
    expect(secondContent).toContain('context');
  });

  it('should not modify messages without text siblings', () => {
    const messages: TestMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'read', input: {} }],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'output' },
        ],
      },
    ];
    const result = normalizeMessagesForAPI(messages);
    const blocks = result[1]!.content as TestBlock[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe('tool_result');
  });

  it('should filter non-text blocks from is_error tool_results', () => {
    const messages: TestMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'bash', input: {} }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_1',
            content: 'error output',
            is_error: true,
          },
          { type: 'text', text: 'extra note' },
          { type: 'text', text: 'more info' },
        ],
      },
    ];
    const result = normalizeMessagesForAPI(messages);
    const blocks = result[1]!.content as TestBlock[];
    expect(blocks).toHaveLength(1);
    // Text should be smooshed — is_error filters non-text, but text blocks are ok
    const content = typeof blocks[0]!.content === 'string'
      ? blocks[0]!.content
      : '';
    expect(content).toContain('error output');
    expect(content).toContain('extra note');
    expect(content).toContain('more info');
  });
});

// ---------------------------------------------------------------------------
// ensureToolResultPairing
// ---------------------------------------------------------------------------

describe('ensureToolResultPairing', () => {
  it('should not modify well-formed messages', () => {
    const messages: TestMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'read', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'output' },
        ],
      },
    ];
    const result = normalizeMessagesForAPI(messages);
    expect(result).toHaveLength(2);
    expect(result[0]!.role).toBe('assistant');
    expect(result[1]!.role).toBe('user');
  });

  it('should inject synthetic placeholder for missing tool_result', () => {
    const messages: TestMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'read', input: {} },
        ],
      },
    ];
    const result = normalizeMessagesForAPI(messages);
    expect(result).toHaveLength(2); // assistant + synthetic user
    expect(result[1]!.role).toBe('user');
    const blocks = result[1]!.content as TestBlock[];
    expect(blocks[0]!.type).toBe('tool_result');
    expect((blocks[0] as { is_error: boolean }).is_error).toBe(true);
    expect((blocks[0] as { content: string }).content).toBe(MISSING_TOOL_RESULT_PLACEHOLDER);
  });

  it('should strip orphaned tool_results (no matching tool_use)', () => {
    const messages: TestMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_orphan', content: 'orphan' },
          { type: 'text', text: 'hello' },
        ],
      },
    ];
    const result = normalizeMessagesForAPI(messages);
    // Orphaned tool_result stripped; text 'hello' preserved
    expect(result).toHaveLength(1);
    const blocks = result[0]!.content as TestBlock[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe('text');
    expect(blocks[0]!.text).toBe('hello');
  });

  it('should handle multiple tool_use blocks where one result is missing', () => {
    const messages: TestMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'read', input: {} },
          { type: 'tool_use', id: 'tu_2', name: 'write', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'output' },
          // tu_2 result is missing
        ],
      },
    ];
    const result = normalizeMessagesForAPI(messages);
    expect(result).toHaveLength(2);
    const userBlocks = result[1]!.content as TestBlock[];
    const trIds = userBlocks
      .filter((b) => b.type === 'tool_result')
      .map((b) => (b as { tool_use_id: string }).tool_use_id);
    expect(trIds).toContain('tu_1'); // real result
    expect(trIds).toContain('tu_2'); // synthetic placeholder
  });

  it('should strip duplicate tool_result blocks', () => {
    const messages: TestMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'read', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'first' },
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'duplicate' },
        ],
      },
    ];
    const result = normalizeMessagesForAPI(messages);
    const userBlocks = result[1]!.content as TestBlock[];
    const trCount = userBlocks.filter((b) => b.type === 'tool_result').length;
    expect(trCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Integration: full pipeline on realistic scenario
// ---------------------------------------------------------------------------

describe('full pipeline scenarios', () => {
  it('should handle background agent injection pattern', () => {
    // Simulate: tool results + background agent notification as separate user messages
    const messages: TestMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'read', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'file output' },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: '[Background agent results]\nAgent completed.' },
        ],
      },
    ];
    const result = normalizeMessagesForAPI(messages);

    // Should have 2 messages: assistant + merged user
    expect(result).toHaveLength(2);
    expect(result[0]!.role).toBe('assistant');

    const userBlocks = result[1]!.content as TestBlock[];
    // tool_result + text should be merged into one message with text smooshed
    expect(userBlocks).toHaveLength(1); // tool_result with smooshed text
    expect(userBlocks[0]!.type).toBe('tool_result');
    const content = typeof userBlocks[0]!.content === 'string'
      ? userBlocks[0]!.content
      : '';
    expect(content).toContain('file output');
    expect(content).toContain('Background agent results');
  });

  it('should handle multiple turns correctly', () => {
    const messages: TestMessage[] = [
      { role: 'user', content: 'Hello' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'read', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'output' },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I found the following...' },
        ],
      },
    ];
    const result = normalizeMessagesForAPI(messages);
    // All messages preserved in correct roles
    expect(result.map((m) => m.role)).toEqual([
      'user', 'assistant', 'user', 'assistant',
    ]);
  });
});
