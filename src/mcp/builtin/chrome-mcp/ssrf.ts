/**
 * SSRF protection — prevents navigation to private/internal IPs.
 *
 * Extracted from web-bridge-cli.ts:isPrivateHost().
 */

import { isIP } from 'node:net';

/** Check if a hostname resolves to a private/internal IP. */
export function isPrivateHost(hostname: string): boolean {
  // IPv4 private ranges
  if (isIP(hostname) === 4) {
    const octets = hostname.split('.').map(Number);
    if (octets[0] === 10) return true;
    if (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) return true;
    if (octets[0] === 192 && octets[1] === 168) return true;
    if (octets[0] === 127) return true;
    if (octets[0] === 0) return true;
    return false;
  }

  // IPv6 private ranges
  if (isIP(hostname) === 6) {
    const lower = hostname.toLowerCase();
    if (lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd')) {
      return true;
    }
    if (lower.startsWith('fe80:')) return true;
    return false;
  }

  // Named hosts: check common private suffixes
  const lower = hostname.toLowerCase();
  if (lower === 'localhost' || lower === 'localhost.localdomain') return true;
  if (lower.endsWith('.local') || lower.endsWith('.internal')) return true;

  return false;
}

/** Validate a URL doesn't target internal hosts. Throws on private target. */
export function validateUrl(urlStr: string): URL {
  const url = new URL(urlStr);

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(
      `Blocked navigation to "${url.protocol}" protocol. Only http and https are allowed.`,
    );
  }

  if (isPrivateHost(url.hostname)) {
    throw new Error(
      `Blocked navigation to "${url.hostname}" — private/internal hosts are not accessible.`,
    );
  }

  return url;
}
