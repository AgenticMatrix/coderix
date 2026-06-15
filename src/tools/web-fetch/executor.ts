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
    const msg = (err as Error).message;

    // 404 / 403 / 401 are valid HTTP responses, not tool errors.
    // The tool worked — the page just doesn't exist or blocks us.
    if (
      msg.startsWith('HTTP 404') ||
      msg.startsWith('HTTP 403') ||
      msg.startsWith('HTTP 401')
    ) {
      return {
        content: msg,
        isError: false,
        metadata: { httpStatus: msg.match(/^HTTP (\d+)/)?.[1] },
      };
    }

    // Network errors, timeouts, DNS failures — real errors
    return {
      content: `Web fetch failed: ${msg}`,
      isError: true,
    };
  }
};
