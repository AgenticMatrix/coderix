import { describe, it, expect } from 'vitest';

import { chatReducer, createInitialState } from '../../hooks/useChatReducer.js';
import { splitTranscript, initialEpoch, advanceEpoch } from '../transcript-commit.js';
import type { ChatState, ChatAction, Message, ToolUseBlock } from '../../../types.js';

/**
 * The reported symptom is a LADDER: the same tool block appears many times down
 * the transcript, each copy a more complete rendering than the one above it
 * (`○ Bash(…)`, then `● Bash(…)`, then `● Bash(…)` plus the command, then plus
 * the output).
 *
 * A ladder is not the two-copy stale/fresh pattern. Two copies means one frame
 * was overwritten once. N copies, each newer than the last, means the committed
 * region was REPRINTED N times: scrollback cannot retract, so every reprint
 * restates history in whatever form it had at that moment and stacks it below
 * the previous copy.
 *
 * `<Static>` reprints exactly when its key changes, and that key is
 * `advanceEpoch`'s token. So the invariant is:
 *
 *     while a turn is merely streaming, the token must not change.
 *
 * Driven through the REAL reducer with the real action sequence of a turn, so
 * these constrain the shipped state machine rather than a reconstruction of it.
 */

let nextId = 1;

function userMessage(text: string): Message {
  return {
    id: nextId++,
    role: 'user',
    content: text,
    blocks: [{ type: 'text', content: text }],
    timestamp: Date.now(),
  };
}

function toolBlock(toolId: string, input: Record<string, unknown>): ToolUseBlock {
  return {
    type: 'tool_use',
    toolId,
    toolName: 'bash',
    input,
    state: 'pending',
  } as ToolUseBlock;
}

/**
 * Replay a turn action by action, collecting the `<Static>` key each frame would
 * have used. Mirrors `App.tsx`: commit what `splitTranscript` allows, then mint
 * a token from it.
 */
function replay(actions: readonly ChatAction[]): {
  tokens: string[];
  committed: number[];
  final: ChatState;
} {
  let state = createInitialState('test-model');
  let epoch = initialEpoch();
  const tokens: string[] = [];
  const committed: number[] = [];

  for (const action of actions) {
    state = chatReducer(state, action);
    const committable = splitTranscript(state.messages).committed.length;
    epoch = advanceEpoch(epoch, {
      renderRevision: state.renderRevision,
      committedCount: committable,
      subAgentId: state.subAgentView?.agentId,
    });
    tokens.push(epoch.token);
    committed.push(committable);
  }
  return { tokens, committed, final: state };
}

/** One assistant turn running a single tool, input streaming in as JSON deltas. */
function turnWithTool(toolId: string): ChatAction[] {
  const msgId = nextId++;
  return [
    { type: 'ADD_USER_MESSAGE', message: userMessage(`run ${toolId}`) },
    { type: 'START_ASSISTANT_RESPONSE', id: msgId },
    { type: 'START_BLOCK', messageId: msgId, block: toolBlock(toolId, { _partial: '{"command":"ec' }) },
    // The partial input growing is the "progressively more complete" rendering.
    { type: 'APPEND_BLOCK_DELTA', messageId: msgId, deltaType: 'json', text: 'ho hi"}' },
    { type: 'STOP_BLOCK', messageId: msgId },
    { type: 'UPDATE_BLOCK_STATE', toolId, state: 'executing' },
    { type: 'SET_TOOL_USE_RESULT', toolId, duration: 12, result: { content: 'hi', isError: false } },
    { type: 'FINISH_ASSISTANT_RESPONSE', id: msgId },
  ];
}

describe('the committed region while a turn streams', () => {
  it('keeps one key for a whole turn, so history is never reprinted', () => {
    const { tokens } = replay(turnWithTool('t1'));
    expect(new Set(tokens).size, `keys seen: ${[...new Set(tokens)].join(', ')}`).toBe(1);
  });

  it('keeps one key when several tools run concurrently', () => {
    // The reported trigger: two tools interleave, and settle out of order.
    const msgId = nextId++;
    const actions: ChatAction[] = [
      { type: 'ADD_USER_MESSAGE', message: userMessage('run both') },
      { type: 'START_ASSISTANT_RESPONSE', id: msgId },
      { type: 'START_BLOCK', messageId: msgId, block: toolBlock('a', { command: 'echo a' }) },
      { type: 'START_BLOCK', messageId: msgId, block: toolBlock('b', { command: 'echo b' }) },
      { type: 'UPDATE_BLOCK_STATE', toolId: 'a', state: 'executing' },
      { type: 'UPDATE_BLOCK_STATE', toolId: 'b', state: 'executing' },
      // b finishes first — the out-of-order settle.
      { type: 'SET_TOOL_USE_RESULT', toolId: 'b', duration: 5, result: { content: 'b', isError: false } },
      { type: 'SET_TOOL_USE_RESULT', toolId: 'a', duration: 9, result: { content: 'a', isError: false } },
      { type: 'FINISH_ASSISTANT_RESPONSE', id: msgId },
    ];

    const { tokens } = replay(actions);
    expect(new Set(tokens).size, `keys seen: ${[...new Set(tokens)].join(', ')}`).toBe(1);
  });

  it('keeps one key across several consecutive turns', () => {
    // History growing is what `<Static>`'s own append path is for; remounting
    // on growth would reprint the whole transcript per message.
    const { tokens } = replay([
      ...turnWithTool('t1'),
      ...turnWithTool('t2'),
      ...turnWithTool('t3'),
    ]);
    expect(new Set(tokens).size, `keys seen: ${[...new Set(tokens)].join(', ')}`).toBe(1);
  });

  it('never commits a message while any of its tools is unsettled', () => {
    // The safety rule behind the ladder: committing an unsettled message
    // strands a half-rendered copy that the live region then redraws.
    const streaming = turnWithTool('t1');
    // Cut before SET_TOOL_USE_RESULT, so the tool is still executing.
    const { final } = replay(streaming.slice(0, 6));

    const { committed } = splitTranscript(final.messages);
    for (const message of committed) {
      const live = message.blocks.filter(
        (b) => b.type === 'tool_use' && b.state !== 'done' && b.state !== 'error',
      );
      expect(live, `message ${message.id} committed with a live tool`).toEqual([]);
    }
  });

  it('does commit the turn once its tool has settled', () => {
    // The counterpart: the boundary must still advance, or nothing reaches
    // scrollback and the commit half of the design is dead code.
    const { committed } = replay([...turnWithTool('t1'), ...turnWithTool('t2')]);
    expect(committed.at(-1), 'settled turns are committable').toBeGreaterThan(0);
  });
});
