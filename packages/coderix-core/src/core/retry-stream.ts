/**
 * retry-stream.ts — Retry a model call that failed before producing output.
 *
 * The provider adapters stream their answer, so a failure can land at two very
 * different moments:
 *
 *   - **Before anything was emitted.** The request was rejected (429/5xx), the
 *     socket died, or the first byte never arrived. Nothing reached the user or
 *     the transcript, so the call can simply be issued again.
 *   - **After output started.** Text or a tool call is already visible. Re-issuing
 *     the call would duplicate that content and could re-run a tool the harness
 *     already acted on, so the failure must surface instead.
 *
 * This wrapper only covers the first case. `emitted` flips as soon as the
 * generator yields anything the caller can observe, and from that point errors
 * propagate untouched.
 *
 * Subtlety worth keeping in mind: `message_start` deliberately does NOT count as
 * output. Both adapters emit it as soon as the response headers arrive, carrying
 * only the model name and (empty) usage. Treating it as output would disable
 * retries for every mid-stream failure — the exact case this exists to fix.
 */

import { classifyError, type ClassifiedError } from './error-recovery.js';
import type { AssistantMessage, StreamEvent } from './types.js';

export interface RetryStreamOptions {
  /** Extra attempts after the first try. 0 disables retrying. */
  maxRetries: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** User interrupt. Checked before every retry and during the wait. */
  abortSignal?: AbortSignal;
  /** Called before each retry; `attempt` is 1-based and counts retries only. */
  onRetry?: (attempt: number, classified: ClassifiedError, delayMs: number) => void;
  /** Override for tests; defaults to the shared classifier. */
  classify?: (error: Error) => ClassifiedError;
}

export interface ResolvedRetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 30_000;

function readNonNegativeInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn(`[retry] ignoring invalid ${name}=${JSON.stringify(raw)}; using ${fallback}`);
    return fallback;
  }
  return Math.floor(parsed);
}

/**
 * Read retry settings from the environment.
 *
 * Operators on a flaky relay need to tune this without a rebuild, and a value of
 * 0 must be honoured so retrying can be turned off entirely.
 */
export function resolveRetryConfig(env: NodeJS.ProcessEnv = process.env): ResolvedRetryConfig {
  const maxRetries = readNonNegativeInt(
    env.CODERIX_LLM_MAX_RETRIES,
    DEFAULT_MAX_RETRIES,
    'CODERIX_LLM_MAX_RETRIES',
  );
  const baseDelayMs = readNonNegativeInt(
    env.CODERIX_LLM_RETRY_BASE_MS,
    DEFAULT_BASE_DELAY_MS,
    'CODERIX_LLM_RETRY_BASE_MS',
  );
  const maxDelayMs = readNonNegativeInt(
    env.CODERIX_LLM_RETRY_MAX_MS,
    DEFAULT_MAX_DELAY_MS,
    'CODERIX_LLM_RETRY_MAX_MS',
  );
  return { maxRetries, baseDelayMs, maxDelayMs: Math.max(maxDelayMs, baseDelayMs) };
}

/** Exponential backoff with upward jitter, capped at `maxDelayMs`. */
export function computeRetryDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  const exponential = baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * exponential * 0.5;
  return Math.min(Math.round(exponential + jitter), maxDelayMs);
}

/** Sleep that resolves early when the signal aborts. Never rejects. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * True once the caller could have seen something. `message_start` and `ping`
 * carry no content, so they leave the call retryable.
 */
function isObservableOutput(event: StreamEvent | AssistantMessage): boolean {
  if (!('type' in event)) {
    // A direct AssistantMessage (the non-streaming fallback) is the whole answer.
    return 'role' in event && (event as AssistantMessage).role === 'assistant';
  }
  switch (event.type) {
    case 'message_start':
    case 'ping':
    case 'request_start':
    case 'cost_update':
      return false;
    default:
      return true;
  }
}

/**
 * Wrap a model-call generator so a failure that produced no output is retried.
 *
 * `factory` is called once per attempt: an AsyncGenerator cannot be re-consumed,
 * so every retry needs a fresh one.
 */
export async function* withStreamRetry(
  factory: () => AsyncGenerator<StreamEvent | AssistantMessage>,
  options: RetryStreamOptions,
): AsyncGenerator<StreamEvent | AssistantMessage> {
  const {
    maxRetries,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    abortSignal,
    onRetry,
    classify = classifyError,
  } = options;

  let attempt = 0;
  for (;;) {
    const generator = factory();
    let emitted = false;
    /**
     * Content-free events (`message_start`, `ping`, …) are held back until this
     * attempt produces something observable. If the attempt dies without any
     * output, they are dropped with it — otherwise the caller would see two
     * `message_start`s (one per attempt) for what it believes is one message.
     */
    const pending: Array<StreamEvent | AssistantMessage> = [];

    try {
      for await (const event of generator) {
        if (isObservableOutput(event)) {
          if (!emitted) {
            emitted = true;
            for (const held of pending) yield held;
            pending.length = 0;
          }
        } else if (!emitted) {
          pending.push(event);
          continue;
        }
        yield event;
      }
      // The stream ended cleanly without ever producing output — forward what we
      // held so a legitimately empty answer is not silently swallowed.
      for (const held of pending) yield held;
      return;
    } catch (error: unknown) {
      // A user interrupt is not a failure and must never be retried.
      if (abortSignal?.aborted) {
        throw error instanceof Error ? error : new Error(String(error));
      }

      const err = error instanceof Error ? error : new Error(String(error));
      const classified = classify(err);
      const canRetry = classified.retryable && !emitted && attempt < maxRetries;

      if (!canRetry) throw err;

      const delayMs = computeRetryDelay(attempt, baseDelayMs, maxDelayMs);
      attempt += 1;
      onRetry?.(attempt, classified, delayMs);

      // Make the retry observable. An endpoint that accepts the connection and
      // then never sends a byte produces no output at all, so the held events
      // are dropped with the attempt and the consumer hears nothing for the
      // whole backoff — minutes of a UI that looks dead. Re-emitting the
      // content-free `request_start` re-asserts "waiting on the model" and gives
      // the caller the event it needs to drain the retry notice it just queued.
      for (const held of pending) {
        if ('type' in held && held.type === 'request_start') yield held;
      }
      pending.length = 0;

      await abortableSleep(delayMs, abortSignal);
      // Aborted while waiting: stop quietly rather than starting another call.
      if (abortSignal?.aborted) throw err;
    } finally {
      // Release the abandoned attempt's resources (an open HTTP body, timers).
      // A completed generator is already closed; this is a no-op then.
      void generator.return?.(undefined as never);
    }
  }
}