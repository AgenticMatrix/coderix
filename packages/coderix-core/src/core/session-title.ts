/**
 * Session title strategy — deterministic fallback plus optional LLM refinement.
 *
 * Ported from deepseek-harness' session-title policy, minus its event-sourced
 * projection layer: coderix keeps the accepted title in `meta.json`, but the
 * derivation rules (first human prompt only, terminal-safe text, UTF-8 byte
 * caps, non-blocking summarization) are shared here so every client agrees.
 */

import type { AssistantMessage, Message, StreamEvent } from './types.js';

/** Where an accepted session title came from. */
export type SessionTitleSource = 'default' | 'fallback' | 'provider' | 'user' | 'fork';

/** Callback shape accepted by {@link summarizeSessionTitle}. */
export type TitleCallModel = (params: {
  system: string;
  messages: Message[];
  tools: unknown[];
  signal: AbortSignal;
  maxTokens?: number;
  thinking?: { type: 'adaptive' } | { type: 'enabled'; budget_tokens: number } | { type: 'disabled' };
}) => AsyncGenerator<StreamEvent | AssistantMessage>;

export interface SummarizeSessionTitleOptions {
  /** Maximum UTF-8 bytes sent to the model. Longer prompts keep the fallback. */
  maxInputBytes?: number;
  /** Output-token cap for the auxiliary request. */
  maxOutputTokens?: number;
  /** End-to-end deadline for the auxiliary request. */
  timeoutMs?: number;
  /** Caller cancellation (e.g. the session was renamed by the user). */
  signal?: AbortSignal;
}

/** Built-in fallback limits (deepseek-harness defaults). */
export const TITLE_FALLBACK_MAX_WORDS = 5;
export const TITLE_FALLBACK_MAX_BYTES = 40;
/** Accepted-title ceiling, also used for provider output. */
export const TITLE_MAX_BYTES = 80;
export const TITLE_MAX_INPUT_BYTES = 4096;
export const TITLE_MAX_OUTPUT_TOKENS = 64;
export const TITLE_TIMEOUT_MS = 60_000;
/** Language targets in the auxiliary prompt. */
export const TITLE_TARGET_WORDS = 5;
export const TITLE_TARGET_CJK_CHARACTERS = 10;

/** OS command escape sequences, including unterminated tails. */
const OSC_SEQUENCE = /(?:\u001B\]|\u009D)(?:(?!\u0007|\u001B\\)[\s\S])*(?:\u0007|\u001B\\|$)/gu;
/** Control-sequence-introducer escapes such as SGR color codes. */
const CSI_SEQUENCE = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/gu;
/** Remaining two-byte ESC control sequences. */
const ESC_SEQUENCE = /\u001B[@-_]/gu;
/** Non-whitespace C0/C1 control characters. */
const CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;
/** Directional and invisible controls that can make a displayed title deceptive. */
const DIRECTIONAL_CONTROL = /[\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/gu;

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

/** Remove terminal controls and produce one trimmed, whitespace-normalized line. */
export function cleanTitleText(input: string): string {
  return input
    .replace(OSC_SEQUENCE, '')
    .replace(CSI_SEQUENCE, '')
    .replace(ESC_SEQUENCE, '')
    .replace(CONTROL_CHARACTER, '')
    .replace(DIRECTIONAL_CONTROL, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Truncate to a UTF-8 byte budget without splitting a Unicode code point.
 */
export function truncateTitleUtf8(input: string, maxBytes: number): string {
  assertPositiveInteger('maxBytes', maxBytes);
  if (Buffer.byteLength(input, 'utf8') <= maxBytes) return input;
  let used = 0;
  let output = '';
  for (const character of input) {
    const bytes = Buffer.byteLength(character, 'utf8');
    if (used + bytes > maxBytes) break;
    output += character;
    used += bytes;
  }
  return output;
}

/** Normalize an untrusted title and enforce its UTF-8 byte budget. */
export function normalizeSessionTitle(
  input: string,
  maxBytes: number = TITLE_MAX_BYTES,
): string {
  return truncateTitleUtf8(cleanTitleText(input), maxBytes).trimEnd();
}

/** Derive the deterministic fallback from the first eligible human prompt. */
export function fallbackSessionTitle(
  input: string,
  maxWords: number = TITLE_FALLBACK_MAX_WORDS,
  maxBytes: number = TITLE_FALLBACK_MAX_BYTES,
): string {
  assertPositiveInteger('maxWords', maxWords);
  const words = cleanTitleText(input).split(' ').filter(Boolean).slice(0, maxWords);
  return truncateTitleUtf8(words.join(' '), maxBytes).trimEnd();
}

/**
 * Whether a stored title carries no topic signal and may be regenerated.
 * Legacy rows have no source, so they keep the old placeholder regex.
 */
export function isPlaceholderTitle(title: string | undefined, source?: SessionTitleSource): boolean {
  if (!title) return true;
  if (source === 'provider' || source === 'user' || source === 'fork') return false;
  if (source === 'fallback' || source === 'default') return true;
  return title === '新对话'
    || title === 'New chat'
    || /^Session [0-9a-f]{8}$/.test(title)
    || /\.{3}$/.test(title);
}

/** Stable language-aware system instruction. */
export function titleSystemPrompt(): string {
  return [
    'Create a concise title for an AI coding-assistant session from the supplied human messages.',
    'Return only the title on one line, in plain text of natural language, with no quotes, prefix, explanation, Markdown, XML, or terminal control codes. No code is allowed.',
    'Use the language of the messages.',
    `Aim for about ${TITLE_TARGET_WORDS} words in non-CJK languages or ${TITLE_TARGET_CJK_CHARACTERS} CJK characters.`,
  ].join('\n');
}

/** Frame the first human message as JSON so user text cannot break delimiters. */
export function frameTitleInput(text: string): string {
  return `Generate the session title from this JSON array of human messages:\n${JSON.stringify([{ text }])}`;
}

function combineSignals(signals: AbortSignal[]): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const listeners: Array<() => void> = [];
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    const onAbort = (): void => controller.abort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    listeners.push(() => signal.removeEventListener('abort', onAbort));
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const remove of listeners) remove();
    },
  };
}

function textFromAssistant(message: AssistantMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join(' ');
}

/**
 * Summarize the first human prompt into a short title.
 *
 * Best-effort by design: any failure (input too large, timeout, provider error,
 * empty output) returns `null` so the caller keeps its deterministic fallback.
 * The request runs on the caller's `callModel`, i.e. the session's own model
 * route, and is never written into the session transcript.
 */
export async function summarizeSessionTitle(
  callModel: TitleCallModel,
  text: string,
  options: SummarizeSessionTitleOptions = {},
): Promise<string | null> {
  const cleaned = cleanTitleText(text);
  if (!cleaned) return null;

  const framed = frameTitleInput(cleaned);
  const maxInputBytes = options.maxInputBytes ?? TITLE_MAX_INPUT_BYTES;
  if (Buffer.byteLength(framed, 'utf8') > maxInputBytes) return null;

  const timeoutMs = options.timeoutMs ?? TITLE_TIMEOUT_MS;
  const timeoutController = new AbortController();
  const timer = setTimeout(() => {
    timeoutController.abort(new Error(`Session title summarization timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  const combined = combineSignals(
    options.signal ? [options.signal, timeoutController.signal] : [timeoutController.signal],
  );

  try {
    const messages: Message[] = [{ role: 'user', content: framed }];
    const stream = callModel({
      system: titleSystemPrompt(),
      messages,
      tools: [],
      signal: combined.signal,
      maxTokens: options.maxOutputTokens ?? TITLE_MAX_OUTPUT_TOKENS,
      thinking: { type: 'disabled' },
    });

    let raw = '';
    for await (const event of stream) {
      if (combined.signal.aborted) break;
      if (!('type' in event)) {
        raw += textFromAssistant(event);
        continue;
      }
      if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') raw += event.delta.text;
      } else if (event.type === 'message_stop') {
        const finalText = textFromAssistant(event.message);
        if (!raw.trim() && finalText) raw = finalText;
      }
    }

    if (combined.signal.aborted) return null;
    const title = normalizeSessionTitle(raw, TITLE_MAX_BYTES);
    return title || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    combined.dispose();
  }
}

/** Emit a title change to clients without changing the transcript. */
export interface SessionTitleUpdate {
  sessionId: string;
  title: string;
  source: SessionTitleSource;
}
