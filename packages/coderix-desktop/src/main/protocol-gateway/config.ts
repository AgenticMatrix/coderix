/**
 * protocol-gateway/config.ts — Loopback bind address for the conversion gateway.
 *
 * Bound to loopback only — never exposed to the network. Both the gateway
 * server and the claude-code engine (to build a gateway baseUrl) read these, so
 * they cannot drift.
 */

export const GATEWAY_HOST = '127.0.0.1';

export function gatewayPort(): number {
  return parseInt(process.env.CONVERSION_PORT || '7193', 10);
}

export function gatewayUrl(): string {
  return `http://${GATEWAY_HOST}:${gatewayPort()}`;
}
