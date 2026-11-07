import { describe, expect, it } from 'vitest';
import { decideTurnRetry, type TurnRetryState } from '../claude-code-engine.js';

/**
 * The retry decision is the safety-critical part of the claude-code turn loop:
 * it is what prevents a half-streamed answer from being duplicated, and what
 * keeps a user interrupt from being re-issued. It is exported as a pure
 * function so these rules can be pinned without spawning the CLI.
 */

const base: TurnRetryState = {
  repairedImage: false,
  transientRetries: 0,
  substantive: false,
  maxRetries: 3,
  baseDelayMs: 0,
  maxDelayMs: 0,
};

describe('decideTurnRetry — transient failures', () => {
  it('retries a rate-limit failure that produced no output', () => {
    const d = decideTurnRetry(new Error('API Error: 429 rate limit exceeded'), base);
    expect(d.action).toBe('retry');
    expect(d.action === 'retry' && d.reason).toBe('transient');
  });

  it('retries a 5xx before any output', () => {
    expect(decideTurnRetry(new Error('API Error: 503 Service Unavailable'), base).action).toBe('retry');
  });

  it('retries the CLI connection failure', () => {
    expect(decideTurnRetry(new Error('API Error: Connection error.'), base).action).toBe('retry');
  });

  it('retries a timeout', () => {
    expect(decideTurnRetry(new Error('Request timed out.'), base).action).toBe('retry');
  });

  it('stops once the retry budget is spent', () => {
    const d = decideTurnRetry(new Error('503 unavailable'), { ...base, transientRetries: 3 });
    expect(d.action).toBe('fail');
  });

  it('reports the remaining attempts through maxRetries', () => {
    const d = decideTurnRetry(new Error('429 rate limit'), { ...base, transientRetries: 2, maxRetries: 3 });
    expect(d.action).toBe('retry');
  });
});

describe('decideTurnRetry — must NOT retry', () => {
  it('refuses after model text was emitted', () => {
    const d = decideTurnRetry(new Error('503 server error'), { ...base, substantive: true });
    expect(d.action).toBe('fail');
  });

  it('refuses a 400 invalid request', () => {
    expect(decideTurnRetry(new Error('API Error: 400 The request format is invalid'), base).action).toBe('fail');
  });

  it('refuses an auth failure', () => {
    expect(decideTurnRetry(new Error('API Error: 401 invalid api key'), base).action).toBe('fail');
  });

  it('refuses a user abort', () => {
    expect(decideTurnRetry(new Error('Request was aborted'), base).action).toBe('fail');
  });

  it('refuses an unrecognised failure', () => {
    expect(decideTurnRetry(new Error('Claude Code 执行失败'), base).action).toBe('fail');
  });
});

describe('decideTurnRetry — image repair budget is separate', () => {
  const corruptImage = new Error(
    'API Error: 400 messages.1.content.0.tool_result.image.0: unsupported image',
  );

  it('requests the image repair on the first corrupt-image failure', () => {
    const d = decideTurnRetry(corruptImage, base);
    expect(d.action).toBe('retry');
    expect(d.action === 'retry' && d.reason).toBe('image');
  });

  it('does not offer the repair twice', () => {
    const d = decideTurnRetry(corruptImage, { ...base, repairedImage: true });
    // A 400 is not transient, so with the repair already spent the turn fails
    // rather than looping.
    expect(d.action).toBe('fail');
  });

  it('leaves transient retries untouched when the image repair is pending', () => {
    // The image branch is checked first, so a corrupt-image 400 never consumes
    // the network-retry budget.
    const d = decideTurnRetry(corruptImage, { ...base, transientRetries: 0 });
    expect(d.action === 'retry' && d.reason).toBe('image');
  });
});