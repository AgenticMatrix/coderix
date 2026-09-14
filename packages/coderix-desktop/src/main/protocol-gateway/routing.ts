/**
 * protocol-gateway/routing.ts — Resolve the baseUrl the claude-code CLI should
 * hit for a bound model.
 *
 * The claude-code engine speaks Anthropic Messages. An anthropic model returns
 * its own baseUrl (direct, unchanged); an openai model is repointed at the
 * in-process gateway. The CLI appends its own `/v1/messages` suffix, so the
 * gateway baseUrl omits `/v1` — the gateway path then identifies the inbound
 * protocol. Mirrors agentstation-app's `resolveModelBaseUrl` with
 * `harnessProtocol = 'anthropic'` hardcoded (Coderix has only coderix +
 * claude-code, both Anthropic-Messages harnesses).
 */

import { gatewayUrl } from './config.js';
import type { Protocol } from './types.js';

export function resolveClaudeCodeBaseUrl(
  modelName: string,
  baseUrl: string,
  protocol: Protocol,
): string {
  if (protocol === 'openai') {
    return `${gatewayUrl()}/gw/${encodeURIComponent(modelName)}`;
  }
  return baseUrl;
}
