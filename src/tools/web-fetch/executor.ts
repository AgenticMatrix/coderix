import type { ToolExecutor } from '../types.js';
import { fetchUrl } from './fetch-service.js';
import { loadConfig, loadSettings } from '../../cli/config.js';

export const execute: ToolExecutor = async (input, _opts) => {
  const url = String(input.url ?? '');

  if (!url.trim()) {
    return { content: 'No URL provided.', isError: true };
  }

  // Load proxy from config
  let proxy: string | undefined;
  try {
    const config = loadConfig();
    if (config.proxy) {
      proxy = config.proxy;
    }
    // Per-service proxy override from web_search settings
    const settings = loadSettings();
    if (settings.web_search?.proxy) {
      proxy = settings.web_search.proxy;
    }
  } catch {
    // Settings unavailable — use defaults
  }

  try {
    const result = await fetchUrl(url, { proxy });

    const truncated =
      result.content.length >= (256 * 1024) ? ' (truncated)' : '';

    const header = [
      `Fetched: ${result.finalUrl}`,
      `Content-Type: ${result.contentType}`,
      `Status: ${result.status}`,
      `Length: ${result.content.length} bytes${truncated}`,
      result.content.length > 0 ? '' : null,
    ]
      .filter(Boolean)
      .join('\n');

    return {
      content: header + '\n\n' + result.content,
      isError: false,
      metadata: {
        url: result.finalUrl,
        contentType: result.contentType,
        status: result.status,
        byteLength: result.content.length,
      },
    };
  } catch (err) {
    return {
      content: `Web fetch failed: ${(err as Error).message}`,
      isError: true,
    };
  }
};
