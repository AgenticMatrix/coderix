/**
 * MCP Prompt helpers — naming and rendering for server-provided prompt
 * templates (`prompts/list` + `prompts/get`).
 *
 * Names reuse the tool namespace convention: `mcp__<server>__<prompt>`, so a
 * prompt and a tool never collide and permission rules can address them.
 */

import type { GetPromptResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpPrompt } from './types.js';

// ── Name helpers ────────────────────────────────────────────────────────

function sanitize(part: string): string {
  const safe = part.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_');
  return safe.length > 0 ? safe : 'unknown';
}

/** Build the fully-qualified prompt name: `mcp__<server>__<prompt>`. */
export function buildMcpPromptName(serverName: string, promptName: string): string {
  return `mcp__${sanitize(serverName)}__${sanitize(promptName)}`;
}

/** Parse the server and original prompt name back from a qualified name. */
export function parseMcpPromptName(fullName: string): {
  serverName: string;
  promptName: string;
} | null {
  const match = fullName.match(/^mcp__([^_].+?)__(.+)$/);
  if (!match) return null;
  return { serverName: match[1]!, promptName: match[2]! };
}

// ── Rendering ─────────────────────────────────────────────────────────

/**
 * Render the `messages` returned by `prompts/get` into a single text block
 * suitable for `ctx.send()`. Images/audio become placeholders; embedded
 * resources are serialized.
 */
export function renderMcpPromptMessages(messages: GetPromptResult['messages']): string {
  const parts: string[] = [];

  for (const message of messages ?? []) {
    const text = renderPromptContent(message.content);
    if (text) parts.push(text);
  }

  return parts.join('\n\n').trim();
}

function renderPromptContent(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (typeof content !== 'object') return String(content);

  const block = content as Record<string, unknown>;
  if (block.type === 'text' && typeof block.text === 'string') {
    return block.text;
  }
  if (block.type === 'image') {
    const mime = typeof block.mimeType === 'string' ? block.mimeType : 'unknown';
    return `[Image content omitted: ${mime}]`;
  }
  if (block.type === 'audio') {
    const mime = typeof block.mimeType === 'string' ? block.mimeType : 'unknown';
    return `[Audio content omitted: ${mime}]`;
  }
  if (block.type === 'resource') {
    return `[Resource]\n${stringify(block.resource ?? block)}`;
  }
  return stringify(block);
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return String(value);
  }
}

// ── Arguments ─────────────────────────────────────────────────────────

/**
 * Parse `key=value` pairs from a raw command argument string into a prompt
 * arguments object. Positional args (no `=`) are assigned to `positionalKeys`
 * in order — typically the prompt's declared argument names.
 */
export function parsePromptArgs(
  raw: string,
  positionalKeys: readonly string[] = [],
): Record<string, string> {
  const args: Record<string, string> = {};
  const tokens = raw.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  let positionalIndex = 0;

  for (const token of tokens) {
    const unquoted = unquote(token);
    const eq = unquoted.indexOf('=');
    if (eq > 0) {
      args[unquoted.slice(0, eq)] = unquote(unquoted.slice(eq + 1));
    } else if (positionalIndex < positionalKeys.length) {
      args[positionalKeys[positionalIndex]!] = unquoted;
      positionalIndex++;
    }
  }

  return args;
}

function unquote(token: string): string {
  if (token.length >= 2 && (token[0] === '"' || token[0] === "'") && token.at(-1) === token[0]) {
    return token.slice(1, -1);
  }
  return token;
}

/** Build a slash-command help string listing a prompt's arguments. */
export function describeMcpPrompt(prompt: McpPrompt): string {
  const args = (prompt.arguments ?? [])
    .map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`))
    .join(' ');
  return args ? `MCP prompt: ${prompt.description ?? prompt.name} (${args})` : `MCP prompt: ${prompt.description ?? prompt.name}`;
}
