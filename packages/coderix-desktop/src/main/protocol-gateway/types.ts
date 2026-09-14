/**
 * protocol-gateway/types.ts — Wire protocols and converter contract.
 *
 * Coderix has only two wire protocols:
 *   - `anthropic` — the Anthropic Messages API (native to BOTH the in-process
 *     coderix engine and the claude-code engine, which spawns the `claude` CLI).
 *   - `openai`    — OpenAI Chat Completions (what an OpenAI-compatible relay,
 *     e.g. a base_url ending in `/v1`, speaks).
 *
 * The gateway converts inbound `anthropic` requests into `openai` requests so
 * the claude-code CLI can drive OpenAI-compatible models, then converts the
 * response back. Mirrors agentstation-app's protocol-gateway, reduced to this
 * single direction.
 */

export type Protocol = 'anthropic' | 'openai';

/** One outbound SSE frame: an optional `event:` line plus a `data:` payload. */
export interface SseFrame {
  event?: string;
  data: string;
}

/**
 * A stateful per-request converter. The gateway creates one instance per
 * upstream request and feeds it the upstream stream, so converters may keep
 * cross-event state (matching a `content_block_start` to its deltas, etc.).
 */
export interface ProtocolConverter {
  /** Transform an inbound request body into the upstream (model-native) body. */
  convertRequest(body: Record<string, unknown>): Record<string, unknown>;
  /** Transform a non-streaming upstream response body into the inbound body. */
  convertResponse(body: Record<string, unknown>): Record<string, unknown>;
  /** Feed one upstream SSE event (`event:` name + `data:` payload); returns
   *  zero or more outbound frames to relay to the harness. */
  convertSse(event: string | null, data: string): SseFrame[];
  /** The upstream stream ended; returns any trailing frames (e.g. message_stop). */
  finishSse(): SseFrame[];
}

/** A resolved model the gateway forwards to (endpoint + auth + protocol). */
export interface ModelBinding {
  baseUrl: string;
  apiKey: string;
  protocol: Protocol;
  maxTokens?: number;
}

/** Resolves a model name (the gateway path segment) to its binding. */
export type ModelResolver = (modelName: string) => ModelBinding | undefined;
