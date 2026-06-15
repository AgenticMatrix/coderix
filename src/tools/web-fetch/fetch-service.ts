/**
 * Web Fetch Service — fetches URLs and converts HTML to plain text.
 *
 * Uses undici (already a project dependency) for HTTP requests.
 */

import { isIP } from 'node:net';
import { ProxyAgent, fetch as undiciFetch } from 'undici';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FetchResult {
  /** Plain-text content (HTML stripped). */
  content: string;
  /** Original Content-Type header value. */
  contentType: string;
  /** HTTP status code. */
  status: number;
  /** Final URL after redirects. */
  finalUrl: string;
}

export interface FetchOptions {
  /** Max content length in bytes (default: 256KB). */
  maxContentLength?: number;
  /** Request timeout in ms (default: 10s). */
  timeout?: number;
  /** HTTP/HTTPS proxy URL (uses ProxyAgent). */
  proxy?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDispatcher(proxy?: string): { dispatcher?: ProxyAgent } {
  if (proxy) {
    try {
      return { dispatcher: new ProxyAgent({ uri: proxy }) };
    } catch {
      // Invalid proxy URL — fall through to direct
    }
  }
  return {};
}

/** Check if a hostname resolves to a private/local IP (SSRF prevention). */
function isPrivateHost(hostname: string): boolean {
  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '0.0.0.0'
  ) {
    return true;
  }

  const ipVersion = isIP(hostname);
  if (ipVersion) {
    if (ipVersion === 4) {
      const parts = hostname.split('.').map(Number);
      if (parts[0] === 10) return true;
      if (parts[0] === 127) return true;
      if (parts[0] === 0) return true;
      if (parts[0] === 169 && parts[1] === 254) return true;
      if (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) return true;
      if (parts[0] === 192 && parts[1] === 168) return true;
      return false;
    }
    if (ipVersion === 6) {
      const lower = hostname.toLowerCase();
      if (lower === '::1') return true;
      if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
      if (lower.startsWith('fe8') || lower.startsWith('fe9') ||
          lower.startsWith('fea') || lower.startsWith('feb')) return true;
      return false;
    }
  }

  return false;
}

/**
 * Build a helpful error message based on the fetch error.
 */
function wrapFetchError(err: unknown, url: string, proxy?: string): Error {
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as any)?.code as string | undefined;

  // Undici connect timeout
  if (
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    msg.includes('Connect Timeout') ||
    msg.includes('aborted due to timeout')
  ) {
    const hints: string[] = [
      `Cannot reach ${new URL(url).hostname}.`,
      proxy
        ? `The proxy (${proxy}) may be unreachable.`
        : 'The site may be blocked or unreachable from your network.',
      'If you are behind a firewall or in a restricted network,',
      'configure a proxy in ~/.coder/settings.json under web_search.proxy.',
    ];
    return new Error(hints.join(' '));
  }

  // DNS resolution failure
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || msg.includes('getaddrinfo')) {
    return new Error(
      `DNS lookup failed for ${new URL(url).hostname}. Check your network connection.`,
    );
  }

  // TLS / certificate error
  if (code === 'UND_ERR_TLS' || msg.includes('TLSSocket') || msg.includes('certificate')) {
    return new Error(
      `TLS error connecting to ${new URL(url).hostname}: ${msg}. If using a proxy, check that it supports CONNECT tunneling.`,
    );
  }

  // Generic error — include original message
  return new Error(
    `Failed to fetch ${url}: ${msg}${proxy ? '' : '. If the site is blocked, try configuring a proxy in settings.'}`,
  );
}

// ---------------------------------------------------------------------------
// HTML → Text conversion
// ---------------------------------------------------------------------------

export function htmlToText(html: string): string {
  let text = html;

  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '');
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '');

  text = text.replace(/<\/?(br|hr)[^>]*\/?>/gi, '\n');
  text = text.replace(
    /<\/?(p|div|h[1-6]|li|tr|article|section|header|footer|aside|nav|main|table|ul|ol|dl|blockquote|pre|figure|figcaption|details|summary)[^>]*>/gi,
    '\n',
  );

  text = text.replace(/<[^>]+>/g, '');

  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&ensp;/g, ' ')
    .replace(/&emsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) =>
      String.fromCharCode(parseInt(h, 16)),
    );

  text = text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');

  return text;
}

// ---------------------------------------------------------------------------
// URL fetching
// ---------------------------------------------------------------------------

/**
 * Fetch a URL and return its content as plain text.
 *
 * - Uses `redirect: 'follow'` so undici handles redirects transparently.
 * - Checks the initial URL hostname for private IPs (SSRF prevention).
 * - Truncates content at maxContentLength bytes.
 * - Returns helpful error messages for common failure modes.
 */
export async function fetchUrl(
  url: string,
  opts: FetchOptions = {},
): Promise<FetchResult> {
  const maxContentLength = opts.maxContentLength ?? 256 * 1024;
  const timeout = opts.timeout ?? 10_000;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `Unsupported protocol "${parsed.protocol}". Only HTTP(S) is supported.`,
    );
  }

  if (isPrivateHost(parsed.hostname)) {
    throw new Error(`Cannot fetch private/local address: ${parsed.hostname}`);
  }

  const dispatcher = createDispatcher(opts.proxy);

  let response: Awaited<ReturnType<typeof undiciFetch>>;
  try {
    response = await undiciFetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,text/plain,application/json,*/*',
      },
      signal: AbortSignal.timeout(timeout),
      redirect: 'follow',
      ...dispatcher,
    });
  } catch (err) {
    throw wrapFetchError(err, url, opts.proxy);
  }

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}${response.statusText ? ' ' + response.statusText : ''} from ${response.url || url}`,
    );
  }

  const contentType = response.headers.get('content-type') ?? 'text/plain';
  const finalUrl = response.url || url;

  // Read body up to maxContentLength
  const reader = response.body?.getReader();
  if (!reader) {
    return { content: '', contentType, status: response.status, finalUrl };
  }

  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalLength += value.length;
      if (totalLength > maxContentLength) {
        const remaining = maxContentLength - (totalLength - value.length);
        if (remaining > 0) {
          chunks.push(value.subarray(0, remaining));
        }
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
    }
  } catch (err) {
    throw wrapFetchError(err, url, opts.proxy);
  }

  const total = chunks.reduce((acc, c) => acc + c.length, 0);
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buffer.set(c, offset);
    offset += c.length;
  }

  const decoder = new TextDecoder();
  const rawText = decoder.decode(buffer);

  const isHtml =
    contentType.includes('text/html') ||
    contentType.includes('application/xhtml');
  const content = isHtml ? htmlToText(rawText) : rawText;

  return { content, contentType, status: response.status, finalUrl };
}
