import { describe, it, expect } from 'vitest';

import { chatReducer, createInitialState } from '../../hooks/useChatReducer.js';
import type { ChatAction, Message, ThinkingBlock } from '../../../types.js';

/**
 * Regression: a sub-agent turn that ends with an engine `done` but no
 * `message_stop` (non-streaming provider, compacted turn, aborted stream)
 * used to leave `isStreaming` true forever while `respondingDone` was set
 * by FINISH_TURN. The ActivityLine — which keys off `isStreaming` — kept
 * rendering "✽ Streaming…", while the status bar (keyed off
 * `mainStreaming`/`respondingDone`) showed idle: a terminated agent still
 * displaying streaming.
 *
 * The invariant this guards:
 *   - while background tools / sub-agents run, the turn is NOT done
 *     (FINISH_TURN only arrives with the engine's `done`);
 *   - once the engine says `done` — nothing running, no LLM output — the
 *     streaming flag MUST be reset in the same turn, so nothing can render
 *     "Streaming…" for a dead turn.
 *
 * Driven through the REAL reducer with the action sequence
 * useSubAgentBridge dispatches for `done`
 * (FINISH_ASSISTANT_RESPONSE + FINISH_TURN — the same safety net
 * useAgentBridge has on its `done`).
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

function thinkingBlock(): ThinkingBlock {
  return { type: 'thinking', content: 'thinking…' } as ThinkingBlock;
}

describe('sub-agent done without message_stop', () => {
  it('resets isStreaming when the engine emits done (no premature streaming)', () => {
    let state = createInitialState('test-model');
    state = chatReducer(state, { type: 'ADD_USER_MESSAGE', message: userMessage('run it') });
    state = chatReducer(state, { type: 'START_ASSISTANT_RESPONSE', id: 7 });

    // An in-progress thinking block: without FINISH_ASSISTANT_RESPONSE it
    // never gets a duration and would look "still thinking" forever.
    state = chatReducer(state, {
      type: 'START_BLOCK',
      messageId: 7,
      block: thinkingBlock(),
    });

    expect(state.isStreaming).toBe(true);

    // Engine `done` — the action sequence useSubAgentBridge dispatches.
    state = chatReducer(state, { type: 'FINISH_ASSISTANT_RESPONSE', id: 7 });
    state = chatReducer(state, { type: 'FINISH_TURN' });

    // The turn is dead: nothing may render streaming/thinking for it.
    expect(state.isStreaming).toBe(false);
    expect(state.respondingDone).toBe(true);
    expect(state.thinkingStartedAt).toBeUndefined();

    // The thinking block was finalized (the message carries a duration, which
    // is what App.tsx's findLatestThinking reads) so it cannot be mistaken
    // for an in-progress one.
    const last = state.messages[state.messages.length - 1]!;
    expect(last.thinkingDuration).toBeGreaterThan(0);
  });

  it('keeps the streaming flag live across a tool turn until the engine says done', () => {
    let state = createInitialState('test-model');
    state = chatReducer(state, { type: 'ADD_USER_MESSAGE', message: userMessage('run it') });
    state = chatReducer(state, { type: 'START_ASSISTANT_RESPONSE', id: 7 });
    state = chatReducer(state, { type: 'FINISH_ASSISTANT_RESPONSE', id: 7 });
    // A tool turn: tools still settling, next LLM call not started yet —
    // the turn has NOT finished responding.
    expect(state.isStreaming).toBe(false);
    expect(state.respondingDone).toBe(false);
  });
});
