/**
 * Web Search Service — pluggable backends for web search.
 *
 * Default: Bing HTML scraping (free, no API key).
 *   - Uses cc=us for international-quality results on English queries.
 *   - Falls back to cn.bing.com for Chinese queries.
 * Optional: DuckDuckGo HTML, Brave Search API, Bing Web Search API.
 */

import { ProxyAgent, fetch as undiciFetch } from 'undici';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchOptions {
  allowedDomains?: string[];
  blockedDomains?: string[];
  maxResults?: number;
  braveApiKey?: string;
  bingApiKey?: string;
  provider?: 'bing_html' | 'duckduckgo' | 'brave' | 'bing_api';
  proxy?: string;
}

// ---------------------------------------------------------------------------
// Shared helpers
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

/** Detect if a query is primarily Chinese (CJK characters). */
function isChineseQuery(query: string): boolean {
  // Count CJK characters
  const cjk = query.match(/[一-鿿㐀-䶿]/g);
  return cjk ? cjk.length >= 2 : false;
}

// ---------------------------------------------------------------------------
// Backend: Bing HTML (default)
// ---------------------------------------------------------------------------

/**
 * Search Bing via HTML scraping.
 *
 * Strategy:
 * - For English queries: www.bing.com + cc=us&ensearch=1 → international quality
 * - For Chinese queries: cn.bing.com → China-local results
 *
 * Real URLs are extracted from <cite> elements (not the redirect links in <h2>).
 */
async function searchBingHtml(
  query: string,
  maxResults: number,
  proxy?: string,
): Promise<SearchResult[]> {
  const isChinese = isChineseQuery(query);

  const baseUrl = isChinese
    ? 'https://cn.bing.com/search'
    : 'https://www.bing.com/search';

  const params = new URLSearchParams({ q: query, count: String(maxResults) });
  if (!isChinese) {
    params.set('cc', 'us');
    params.set('ensearch', '1');
    params.set('setlang', 'en');
    params.set('mkt', 'en-US');
  }

  const url = `${baseUrl}?${params.toString()}`;
  const response = await undiciFetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'text/html',
      'Accept-Language': isChinese
        ? 'zh-CN,zh;q=0.9,en;q=0.8'
        : 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(10_000),
    ...createDispatcher(proxy),
  });

  if (!response.ok) {
    throw new Error(`Bing returned HTTP ${response.status}`);
  }

  const html = await response.text();
  return parseBingHtmlResults(html, maxResults, isChinese);
}

/**
 * Parse Bing HTML results block-by-block.
 *
 * Each result is in a <li class="b_algo"> block containing:
 *   <h2><a href="bing-redirect">Title</a></h2>  — for title only (href is a tracking redirect)
 *   <cite>display.url › path</cite>              — real URL (display format)
 *   <p class="...b_lineclamp...">Snippet</p>     — snippet text
 *
 * We split on b_algo boundaries first, then extract from each block independently
 * to avoid cross-block mismatches.
 */
function parseBingHtmlResults(
  html: string,
  maxResults: number,
  _isChinese: boolean,
): SearchResult[] {
  // Split into individual b_algo blocks
  const blocks = html.split(/<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>/i);
  // First element is everything before the first b_algo — discard it
  blocks.shift();

  const results: SearchResult[] = [];

  for (const block of blocks) {
    if (results.length >= maxResults) break;

    // --- Title (from <h2><a>) ---
    const titleMatch = block.match(
      /<h2[^>]*><a[^>]*>([\s\S]*?)<\/a><\/h2>/i,
    );
    const title = titleMatch
      ? stripHtml(titleMatch[1]!).trim()
      : '';

    // --- Real URL (from <cite>) ---
    // Bing displays URLs as "https://example.com › path › to › page"
    const citeMatch = block.match(
      /<cite[^>]*>([\s\S]*?)<\/cite>/i,
    );
    let url = '';
    if (citeMatch) {
      url = extractUrlFromCite(citeMatch[1]!);
    }

    // --- Snippet ---
    const snippetMatch = block.match(
      /<p[^>]*class="[^"]*\bb_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i,
    );
    const snippet = snippetMatch
      ? stripHtml(snippetMatch[1]!).trim()
      : '';

    if (title && url) {
      results.push({ title, url, snippet });
    }
  }

  return results;
}

/**
 * Extract a real URL from a Bing <cite> element.
 *
 * Input:  "https://example.com › path › to › page"
 * Output: "https://example.com/path/to/page"
 */
function extractUrlFromCite(citeHtml: string): string {
  // Strip any nested HTML tags
  let text = citeHtml.replace(/<[^>]+>/g, '').trim();

  // Replace breadcrumb separators with /
  text = text.replace(/\s*[›»>]\s*/g, '/');

  // Remove trailing ... or …
  text = text.replace(/[.…]{2,}$/, '');

  // Ensure it starts with http
  if (!text.startsWith('http')) return '';

  try {
    // Validate by parsing
    new URL(text);
    return text;
  } catch {
    return text; // Return best-effort even if URL parse fails
  }
}

// ---------------------------------------------------------------------------
// Backend: DuckDuckGo HTML
// ---------------------------------------------------------------------------

async function searchDuckDuckGo(
  query: string,
  maxResults: number,
  proxy?: string,
): Promise<SearchResult[]> {
  const url = `https://html.duckduckgo.com/html?q=${encodeURIComponent(query)}`;
  const response = await undiciFetch(url, {
    headers: {
      'User-Agent': 'CoderAgent/0.1 (open-source; web-search)',
      'Accept': 'text/html',
    },
    signal: AbortSignal.timeout(10_000),
    ...createDispatcher(proxy),
  });

  if (!response.ok) {
    throw new Error(`DuckDuckGo returned HTTP ${response.status}`);
  }

  const html = await response.text();
  return parseDuckDuckGoResults(html, maxResults);
}

function parseDuckDuckGoResults(
  html: string,
  maxResults: number,
): SearchResult[] {
  const results: SearchResult[] = [];

  const linkRegex =
    /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRegex =
    /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

  const links: Array<{ href: string; title: string }> = [];
  const snippets: string[] = [];

  let match: RegExpExecArray | null;
  while (
    (match = linkRegex.exec(html)) !== null &&
    links.length < maxResults
  ) {
    const rawHref = match[1]!;
    const title = stripHtml(match[2]!).trim();
    const url = extractDuckDuckGoUrl(rawHref);
    if (title && url) {
      links.push({ href: url, title });
    }
  }

  while (
    (match = snippetRegex.exec(html)) !== null &&
    snippets.length < maxResults
  ) {
    const snippet = stripHtml(match[1]!).trim();
    if (snippet) snippets.push(snippet);
  }

  for (let i = 0; i < links.length; i++) {
    results.push({
      title: links[i]!.title,
      url: links[i]!.href,
      snippet: snippets[i] ?? '',
    });
  }

  return results;
}

function extractDuckDuckGoUrl(href: string): string {
  try {
    const url = new URL(
      href.startsWith('http') ? href : `https://html.duckduckgo.com${href}`,
    );
    const uddg = url.searchParams.get('uddg');
    if (uddg) return decodeURIComponent(uddg);
    if (href.startsWith('http')) return href;
  } catch {
    const uddgMatch = href.match(/uddg=([^&]+)/);
    if (uddgMatch) {
      try {
        return decodeURIComponent(uddgMatch[1]!);
      } catch {
        /* ignore */
      }
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// Backend: Brave Search API
// ---------------------------------------------------------------------------

async function searchBrave(
  query: string,
  apiKey: string,
  maxResults: number,
  proxy?: string,
): Promise<SearchResult[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
  const response = await undiciFetch(url, {
    headers: {
      'User-Agent': 'CoderAgent/0.1 (open-source; web-search)',
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': apiKey,
    },
    signal: AbortSignal.timeout(10_000),
    ...createDispatcher(proxy),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `Brave Search returned HTTP ${response.status}: ${body.slice(0, 200)}`,
    );
  }

  const data = (await response.json()) as {
    web?: { results?: Array<{ title: string; url: string; description: string }> };
  };
  return (data.web?.results ?? []).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.description,
  }));
}

// ---------------------------------------------------------------------------
// Backend: Bing Web Search API
// ---------------------------------------------------------------------------

async function searchBingApi(
  query: string,
  apiKey: string,
  maxResults: number,
  proxy?: string,
): Promise<SearchResult[]> {
  const url = `https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(query)}&count=${maxResults}&mkt=en-US`;
  const response = await undiciFetch(url, {
    headers: {
      'User-Agent': 'CoderAgent/0.1 (open-source; web-search)',
      'Accept': 'application/json',
      'Ocp-Apim-Subscription-Key': apiKey,
    },
    signal: AbortSignal.timeout(10_000),
    ...createDispatcher(proxy),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `Bing API returned HTTP ${response.status}: ${body.slice(0, 200)}`,
    );
  }

  const data = (await response.json()) as {
    webPages?: { value?: Array<{ name: string; url: string; snippet: string }> };
  };
  return (data.webPages?.value ?? []).map((r) => ({
    title: r.name,
    url: r.url,
    snippet: r.snippet,
  }));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&ensp;/g, ' ')
    .replace(/&emsp;/g, ' ')
    .replace(/&thinsp;/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&zwnj;/g, '')
    .replace(/&zwj;/g, '')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) =>
      String.fromCharCode(parseInt(h, 16)),
    )
    .replace(/\s+/g, ' ')
    .trim();
}

function matchesDomain(url: string, domains: string[]): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return domains.some((d) => {
      const pattern = d.toLowerCase();
      return hostname === pattern || hostname.endsWith('.' + pattern);
    });
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function searchWeb(
  query: string,
  opts: SearchOptions = {},
): Promise<SearchResult[]> {
  const maxResults = opts.maxResults ?? 10;
  const provider = opts.provider ?? 'bing_html';

  let results: SearchResult[];

  switch (provider) {
    case 'brave':
      results = opts.braveApiKey
        ? await searchBrave(query, opts.braveApiKey, maxResults, opts.proxy)
        : await searchBingHtml(query, maxResults, opts.proxy);
      break;
    case 'bing_api':
      results = opts.bingApiKey
        ? await searchBingApi(query, opts.bingApiKey, maxResults, opts.proxy)
        : await searchBingHtml(query, maxResults, opts.proxy);
      break;
    case 'duckduckgo':
      results = await searchDuckDuckGo(query, maxResults, opts.proxy);
      break;
    case 'bing_html':
    default:
      results = await searchBingHtml(query, maxResults, opts.proxy);
      break;
  }

  if (opts.allowedDomains && opts.allowedDomains.length > 0) {
    results = results.filter((r) => matchesDomain(r.url, opts.allowedDomains!));
  }
  if (opts.blockedDomains && opts.blockedDomains.length > 0) {
    results = results.filter(
      (r) => !matchesDomain(r.url, opts.blockedDomains!),
    );
  }

  return results.slice(0, maxResults);
}
