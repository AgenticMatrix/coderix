/**
 * open-url.ts — detect "open this in the browser" shell commands and extract
 * a URL the embedded browser can load.
 *
 * Shared by both agent engines:
 *   - the claude-code engine (via a PreToolUse hook on the Bash tool), and
 *   - the in-process Coderix engine (via the Bash tool executor wrapper in
 *     index.ts), which is the default engine and would otherwise open the OS
 *     default browser (Chrome) directly.
 */

import { resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Detect a "open this in the browser" shell command and return a URL the
 * embedded browser can load, or null if the command is not such an invocation.
 * Matches the common openers (macOS `open`, Linux `xdg-open`, Windows `start` /
 * `explorer` / `cmd /c start`) when they target:
 *   - an http(s) or localhost/loopback URL, or
 *   - a `file://` URL, or
 *   - a bare local path to an HTML document (`.html`/`.htm`/`.xhtml`), resolved
 *     against `cwd` and returned as a `file://` URL.
 */
export function extractOpenUrl(command: string, cwd?: string): string | null {
  const cmd = command.trim();
  if (!cmd) return null;

  // Strip the opener verb (and any `--flag`-style arguments that precede the
  // target, e.g. `open --reveal`), keeping the rest as the target.
  const opener = /^(?:open|xdg-open|start|explorer|cmd\s+\/c\s+start)(?:\s+--[^\s]+)*\s+/i;
  const openerMatch = cmd.match(opener);
  if (!openerMatch) return null;
  const rest = cmd.slice(openerMatch[0].length).trim();

  // http(s) URL — also matches a bare loopback address (`localhost:3000`,
  // `127.0.0.1:3000`) so it can be normalized to a scheme the view can load.
  const http = rest.match(
    /(https?:\/\/[^\s"'`]+|\blocalhost(?::\d+)?(?:\/[^\s"'`]*)?|\b127\.0\.0\.1(?::\d+)?(?:\/[^\s"'`]*)?)/i,
  );
  if (http) return normalizeWebUrl(http[1]);

  // file:// URL.
  const fileUrl = rest.match(/^file:\/\/[^\s"'`]+/i);
  if (fileUrl) return fileUrl[0];

  // Bare local path — only redirect HTML documents; leave everything else
  // (e.g. `open .`, `open -a "Google Chrome" x`) to the OS default opener.
  let token = rest.split(/\s+/)[0] ?? '';
  token = token.replace(/^(['"])(.*)\1$/, '$2');
  if (!token || token.startsWith('-') || !/\.(?:html?|xhtml)$/i.test(token)) return null;

  const abs = isAbsolute(token) ? token : resolve(cwd ?? process.cwd(), token);
  return pathToFileURL(abs).toString();
}

/** Ensure a web URL has a scheme — bare loopback hosts default to http://. */
function normalizeWebUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `http://${url}`;
}
