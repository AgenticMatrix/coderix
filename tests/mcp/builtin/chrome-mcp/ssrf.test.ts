/**
 * SSRF protection tests.
 *
 * Tests for isPrivateHost() and validateUrl() from chrome-mcp/ssrf.ts.
 */

import { describe, it, expect } from 'vitest';
import { isPrivateHost, validateUrl } from '../../../../src/mcp/builtin/chrome-mcp/ssrf.js';

describe('isPrivateHost', () => {
  it('detects IPv4 loopback', () => {
    expect(isPrivateHost('127.0.0.1')).toBe(true);
    expect(isPrivateHost('127.0.0.99')).toBe(true);
  });

  it('detects IPv4 10.x private range', () => {
    expect(isPrivateHost('10.0.0.1')).toBe(true);
    expect(isPrivateHost('10.255.255.255')).toBe(true);
  });

  it('detects IPv4 172.16-31 private range', () => {
    expect(isPrivateHost('172.16.0.1')).toBe(true);
    expect(isPrivateHost('172.31.255.255')).toBe(true);
  });

  it('rejects 172.32.x.x (not in private range)', () => {
    expect(isPrivateHost('172.32.0.1')).toBe(false);
  });

  it('detects IPv4 192.168.x.x', () => {
    expect(isPrivateHost('192.168.1.1')).toBe(true);
    expect(isPrivateHost('192.168.0.1')).toBe(true);
  });

  it('detects 0.0.0.0', () => {
    expect(isPrivateHost('0.0.0.0')).toBe(true);
  });

  it('allows public IPv4 addresses', () => {
    expect(isPrivateHost('8.8.8.8')).toBe(false);
    expect(isPrivateHost('1.1.1.1')).toBe(false);
    expect(isPrivateHost('93.184.216.34')).toBe(false);
  });

  it('detects IPv6 loopback', () => {
    expect(isPrivateHost('::1')).toBe(true);
  });

  it('detects IPv6 link-local (fe80)', () => {
    expect(isPrivateHost('fe80::1')).toBe(true);
  });

  it('detects IPv6 unique local (fc/fd)', () => {
    expect(isPrivateHost('fc00::1')).toBe(true);
    expect(isPrivateHost('fd00::1')).toBe(true);
  });

  it('detects localhost hostnames', () => {
    expect(isPrivateHost('localhost')).toBe(true);
    expect(isPrivateHost('localhost.localdomain')).toBe(true);
  });

  it('detects .local and .internal TLDs', () => {
    expect(isPrivateHost('myserver.local')).toBe(true);
    expect(isPrivateHost('app.internal')).toBe(true);
  });

  it('allows public hostnames', () => {
    expect(isPrivateHost('example.com')).toBe(false);
    expect(isPrivateHost('google.com')).toBe(false);
    expect(isPrivateHost('github.com')).toBe(false);
  });
});

describe('validateUrl', () => {
  it('parses valid HTTP URLs', () => {
    const url = validateUrl('http://example.com');
    expect(url.hostname).toBe('example.com');
  });

  it('parses valid HTTPS URLs', () => {
    const url = validateUrl('https://example.com/path?q=1');
    expect(url.hostname).toBe('example.com');
  });

  it('rejects non-HTTP protocols', () => {
    expect(() => validateUrl('file:///etc/passwd')).toThrow('protocol');
    expect(() => validateUrl('ftp://example.com')).toThrow('protocol');
    expect(() => validateUrl('javascript:alert(1)')).toThrow('protocol');
  });

  it('blocks private IPv4 addresses', () => {
    expect(() => validateUrl('http://127.0.0.1')).toThrow('private/internal');
    expect(() => validateUrl('http://10.0.0.1')).toThrow('private/internal');
    expect(() => validateUrl('http://192.168.1.1')).toThrow('private/internal');
    expect(() => validateUrl('http://172.16.0.1')).toThrow('private/internal');
  });

  it('blocks localhost', () => {
    expect(() => validateUrl('http://localhost')).toThrow('private/internal');
    expect(() => validateUrl('https://localhost:3000')).toThrow('private/internal');
  });

  it('blocks .local domains', () => {
    expect(() => validateUrl('http://app.local')).toThrow('private/internal');
  });

  it('allows public URLs', () => {
    expect(() => validateUrl('https://example.com')).not.toThrow();
    expect(() => validateUrl('http://api.github.com')).not.toThrow();
    expect(() => validateUrl('https://google.com/search?q=test')).not.toThrow();
  });
});
