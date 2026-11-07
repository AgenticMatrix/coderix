/**
 * protocol-gateway/config.ts — Loopback bind address for the conversion gateway.
 *
 * Bound to loopback only — never exposed to the network. Both the gateway
 * server and the claude-code engine (to build a gateway baseUrl) read these, so
 * they cannot drift.
 *
 * Default port 7393 — deliberately NOT 7193, which agentstation-app's gateway
 * also binds by default. Two loopback gateways on the same port would collide;
 * the loser fails to bind (EADDRINUSE) and every claude-code request silently
 * lands on the *other* app's gateway, which resolves the model with the wrong
 * registry (routing e.g. `Atria-Dawn-Preview` to a local deepseek relay).
 */

export const GATEWAY_HOST = '127.0.0.1';

export function gatewayPort(): number {
  return parseInt(process.env.CONVERSION_PORT || '7393', 10);
}

export function gatewayUrl(): string {
  return `http://${GATEWAY_HOST}:${gatewayPort()}`;
}

/**
 * Upstream idle timeouts for the gateway's outbound fetch.
 *
 * undici defaults both to 300s. A reasoning model can sit silent for minutes
 * before its first token, and a timeout there must NOT be reported as a normal
 * end of stream — the relay now emits an error frame on failure, but a 5-minute
 * ceiling still cut off legitimate long-thinking turns. Raise it and allow an
 * override for unusually slow models.
 */
export function upstreamTimeouts(): { headersTimeout: number; bodyTimeout: number } {
  const fromEnv = parseInt(process.env.GATEWAY_UPSTREAM_TIMEOUT_MS || '', 10);
  const ms = Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 15 * 60 * 1000;
  return { headersTimeout: ms, bodyTimeout: ms };
}
