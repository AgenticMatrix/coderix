import { describe, it, expect } from 'vitest';
import { chatReducer, createInitialState } from '../hooks/useChatReducer.js';
import { MAX_PENDING_IMAGES } from '../clipboard-image.js';
import type { ChatState, PendingImage } from '../../types.js';

/**
 * The pending-image lifecycle. These run against the real reducer, so they
 * catch the failure mode that unit-testing the clipboard reader alone cannot:
 * images staged, then silently cleared on send without ever leaving the state.
 */

const img = (n: number): PendingImage => ({
  mediaType: 'image/png',
  data: `AAAA${n}`,
  width: 100,
  height: 100,
  bytes: 1024,
});

function state(): ChatState {
  return createInitialState('test-model');
}

function stage(s: ChatState, ...images: PendingImage[]): ChatState {
  return images.reduce(
    (acc, image) => chatReducer(acc, { type: 'ADD_PENDING_IMAGE', image }),
    s,
  );
}

describe('pendingImages lifecycle', () => {
  it('starts empty', () => {
    expect(state().pendingImages).toEqual([]);
  });

  it('appends in order', () => {
    const s = stage(state(), img(1), img(2));
    expect(s.pendingImages.map((i) => i.data)).toEqual(['AAAA1', 'AAAA2']);
  });

  it('caps the list and leaves state unchanged past the cap', () => {
    const full = stage(state(), ...Array.from({ length: MAX_PENDING_IMAGES }, (_, i) => img(i)));
    const overflow = chatReducer(full, { type: 'ADD_PENDING_IMAGE', image: img(99) });

    expect(full.pendingImages).toHaveLength(MAX_PENDING_IMAGES);
    // Same object identity: an over-cap press must not churn renders.
    expect(overflow).toBe(full);
  });

  it('removes by index without disturbing the rest', () => {
    const s = stage(state(), img(1), img(2), img(3));
    const after = chatReducer(s, { type: 'REMOVE_PENDING_IMAGE', index: 1 });
    expect(after.pendingImages.map((i) => i.data)).toEqual(['AAAA1', 'AAAA3']);
  });

  it('clears everything', () => {
    const s = stage(state(), img(1), img(2));
    expect(chatReducer(s, { type: 'CLEAR_PENDING_IMAGES' }).pendingImages).toEqual([]);
  });

  it('is a no-op to clear an already empty list', () => {
    const empty = state();
    expect(chatReducer(empty, { type: 'CLEAR_PENDING_IMAGES' })).toBe(empty);
  });

  it('drops the attachments when the user turn is added', () => {
    // ADD_USER_MESSAGE runs on every send; if it did not clear the list, the
    // same image would ride along with every following turn.
    const s = stage(state(), img(1));
    const after = chatReducer(s, {
      type: 'ADD_USER_MESSAGE',
      message: {
        id: 1,
        role: 'user',
        content: 'hi',
        blocks: [{ type: 'text', content: 'hi' }],
        timestamp: Date.now(),
      },
    });
    expect(after.pendingImages).toEqual([]);
  });
});