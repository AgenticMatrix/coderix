/**
 * protocol-gateway/shared.ts — Small helpers shared by the gateway server and
 * converters. Mirrors agentstation-app's protocol-gateway/shared.ts, reduced to
 * Coderix's two protocols (anthropic messages vs. openai chat completions).
 */

import type { Protocol } from './types.js';

export function stripTrailingSlash(s: string): string {
  return s.trim().replace(/\/+$/, '');
}

/** Strip an `/anthropic` alias suffix — several providers (deepseek, minimax,
 *  moonshot, …) expose both an Anthropic- and an OpenAI-compatible path on the
 *  same host. */
export function stripAnthropicAlias(base: string): string {
  return base.replace(/\/anthropic\/?$/i, '');
}

/** The upstream request URL the model's native protocol expects. */
export function buildUpstreamUrl(baseUrl: string, protocol: Protocol): string {
  const base = stripTrailingSlash(baseUrl);
  if (protocol === 'anthropic') return `${base}/v1/messages`;
  return `${stripTrailingSlash(stripAnthropicAlias(base))}/chat/completions`;
}

/** Auth headers for a protocol (Anthropic `x-api-key` vs OpenAI `Bearer`). */
export function headersFor(auth: Protocol, apiKey: string): Record<string, string> {
  return auth === 'anthropic'
    ? { 'anthropic-version': '2023-06-01', 'x-api-key': apiKey }
    : { authorization: `Bearer ${apiKey}` };
}

/** A short-lived unique id; `Date.now` + counter keeps it monotonic without
 *  importing randomness. */
let seq = 0;
export function syntheticId(prefix: string): string {
  seq = (seq + 1) % 0x7fffffff;
  return `${prefix}${Date.now().toString(36)}${seq.toString(36)}`;
}
