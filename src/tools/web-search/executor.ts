import type { ToolExecutor } from '../types.js';
import { searchWeb, type SearchResult } from './search-service.js';
import { loadConfig, loadSettings } from '../../cli/config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatResults(results: SearchResult[]): string {
  if (results.length === 0) {
    return 'No results found.';
  }

  const lines: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    lines.push(`${i + 1}. **${r.title}**`);
    lines.push(`   ${r.url}`);
    if (r.snippet) {
      lines.push(`   ${r.snippet}`);
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export const execute: ToolExecutor = async (input, _opts) => {
  const query = String(input.query ?? '');
  if (!query.trim()) {
    return { content: 'No search query provided.', isError: true };
  }

  const allowedDomains = Array.isArray(input.allowed_domains)
    ? (input.allowed_domains as string[]).filter(Boolean)
    : undefined;
  const blockedDomains = Array.isArray(input.blocked_domains)
    ? (input.blocked_domains as string[]).filter(Boolean)
    : undefined;

  // Load search config from settings
  let braveApiKey: string | undefined;
  let bingApiKey: string | undefined;
  let provider: 'bing_html' | 'duckduckgo' | 'brave' | 'bing_api' = 'bing_html';
  let proxy: string | undefined;

  try {
    // Get proxy from LLM config
    const config = loadConfig();
    if (config.proxy) {
      proxy = config.proxy;
    }

    // Get search-specific config
    const settings = loadSettings();
    if (settings.web_search) {
      if (settings.web_search.provider) {
        provider = settings.web_search.provider;
      }
      if (settings.web_search.brave_api_key &&
          settings.web_search.brave_api_key !== 'YOUR_BRAVE_API_KEY') {
        braveApiKey = settings.web_search.brave_api_key;
      }
      if (settings.web_search.bing_api_key &&
          settings.web_search.bing_api_key !== 'YOUR_BING_API_KEY') {
        bingApiKey = settings.web_search.bing_api_key;
      }
      // Per-service proxy override
      if (settings.web_search.proxy) {
        proxy = settings.web_search.proxy;
      }
    }
  } catch {
    // Settings unavailable — use defaults
  }

  try {
    const results = await searchWeb(query, {
      allowedDomains,
      blockedDomains,
      maxResults: 10,
      provider,
      braveApiKey,
      bingApiKey,
      proxy,
    });

    const content = formatResults(results);
    return {
      content,
      isError: false,
      metadata: {
        searchResults: results,
        resultCount: results.length,
        query,
      },
    };
  } catch (err) {
    return {
      content: `Web search failed: ${(err as Error).message}`,
      isError: true,
    };
  }
};
