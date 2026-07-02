/**
 * MCP Skills — discovers skill:// resources from MCP servers and
 * converts them into Coderix slash commands.
 *
 * When an MCP server exposes resources with `skill://` URIs, each
 * resource is treated as a Skill definition (Markdown with frontmatter).
 * The parsed skills are registered as slash commands.
 */

import { ListResourcesResultSchema, type ListResourcesResult } from '@modelcontextprotocol/sdk/types.js';
import { readResource } from './discovery.js';
import type { ConnectedServer } from './types.js';

// ── Types ───────────────────────────────────────────────────────────────

/** A parsed MCP skill ready to register as a slash command. */
export interface McpSkill {
  /** Skill name (derived from URI, e.g. "mcp__github__create-issue"). */
  name: string;
  /** Display title from frontmatter. */
  title: string;
  /** Description from frontmatter. */
  description: string;
  /** Full markdown content (without frontmatter). */
  content: string;
  /** Source MCP server name. */
  serverName: string;
}

// ── Constants ──────────────────────────────────────────────────────────

const SKILL_URI_PREFIX = 'skill://';

// ── Parsing ────────────────────────────────────────────────────────────

/** Minimal frontmatter parser — extracts YAML-style frontmatter from markdown. */
function parseFrontmatter(markdown: string): {
  frontmatter: Record<string, string>;
  content: string;
} {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, content: markdown };
  }

  const fm: Record<string, string> = {};
  const lines = match[1]!.split('\n');
  for (const line of lines) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)/);
    if (kv) {
      fm[kv[1]!] = kv[2]!.trim();
    }
  }

  return { frontmatter: fm, content: (match[2] ?? '').trim() };
}

// ── Discovery ──────────────────────────────────────────────────────────

/**
 * Discover MCP skills from a connected server.
 *
 * Lists all resources, filters to `skill://` URIs, reads each one,
 * parses frontmatter, and returns McpSkill objects.
 */
export async function discoverMcpSkills(
  server: ConnectedServer,
): Promise<McpSkill[]> {
  if (!server.capabilities?.resources) return [];

  let resources: ListResourcesResult;
  try {
    resources = (await server.client.request(
      { method: 'resources/list' },
      ListResourcesResultSchema,
    )) as ListResourcesResult;
  } catch {
    return [];
  }

  if (!resources.resources) return [];

  const skillResources = resources.resources.filter((r) =>
    r.uri.startsWith(SKILL_URI_PREFIX),
  );

  if (skillResources.length === 0) return [];

  const skills: McpSkill[] = [];

  for (const resource of skillResources) {
    const result = await readResource(server, resource.uri);
    if (!result || !result.contents) continue;

    // Extract text content
    const textContent = result.contents
      .map((c) => ('text' in c ? c.text : undefined))
      .filter(Boolean)
      .join('\n');

    if (!textContent) continue;

    const { frontmatter, content } = parseFrontmatter(textContent);

    // Derive a skill name from the URI
    const rawName = resource.uri.slice(SKILL_URI_PREFIX.length).replace(/[^a-zA-Z0-9_-]/g, '-');
    const skillName = `mcp__${server.name}__${rawName}`;

    skills.push({
      name: skillName,
      title: frontmatter.name ?? frontmatter.title ?? rawName,
      description: frontmatter.description ?? `MCP skill from ${server.name}`,
      content,
      serverName: server.name,
    });
  }

  return skills;
}

/**
 * Convert McpSkill objects into a system prompt appendix describing
 * available MCP skills for the LLM.
 */
export function formatMcpSkillsForPrompt(skills: McpSkill[]): string {
  if (skills.length === 0) return '';

  const lines: string[] = [
    '## MCP Skills',
    '',
    'The following skills are provided by MCP servers. Use /skill-name to invoke them:',
    '',
  ];

  for (const skill of skills) {
    lines.push(`- /${skill.name} — ${skill.description} (from ${skill.serverName})`);
  }

  return lines.join('\n');
}
