/**
 * Agent Memory System — per-agent memory scope injection.
 *
 * Agents can declare a `memory` field in their frontmatter to pull relevant
 * memories from the corresponding scope into their system prompt. This gives
 * each agent type its own persistent memory context across sessions.
 *
 * Supported scopes:
 *   - 'user'     — user-level memories (~/.coder/memory/)
 *   - 'project'  — project-level memories (<project>/.coder/memory/)
 *   - 'local'    — local workspace memories (cwd/.coder/memory/)
 *
 * When memory is enabled and the agent declares a scope, the agent's tool
 * allowlist is automatically extended with Read/Write/Edit so the agent can
 * read from and write to its memory files.
 */

import { readFile, readdir } from 'fs/promises';
import { join, basename, extname } from 'path';
import { homedir } from 'os';

export type AgentMemoryScope = 'user' | 'project' | 'local';

// ---------------------------------------------------------------------------
// Memory directory resolution
// ---------------------------------------------------------------------------

function getMemoryDir(scope: AgentMemoryScope, cwd: string): string {
  switch (scope) {
    case 'user':
      return join(homedir(), '.coder', 'memory');
    case 'project':
      return join(cwd, '.coder', 'memory');
    case 'local':
      return join(cwd, '.coder', 'memory');
    default:
      return join(cwd, '.coder', 'memory');
  }
}

// ---------------------------------------------------------------------------
// Memory prompt assembly
// ---------------------------------------------------------------------------

/**
 * Maximum combined size of memory content injected into a system prompt.
 * Memories beyond this limit are truncated with a note.
 */
const MAX_MEMORY_CHARS = 8_000;

/**
 * Load and assemble the memory prompt for a given agent from the specified
 * scope directory.
 *
 * Returns a string like:
 *   ## Agent Memory (user)
 *   [memory file contents...]
 *
 * Or an empty string if the directory doesn't exist or contains no readable
 * memory files.
 */
export async function loadAgentMemoryPrompt(
  agentType: string,
  scope: AgentMemoryScope,
  cwd: string = process.cwd(),
): Promise<string> {
  const dir = getMemoryDir(scope, cwd);

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return '';
  }

  const memoryFiles = entries
    .filter(e => extname(e).toLowerCase() === '.md')
    .sort();

  if (memoryFiles.length === 0) return '';

  const parts: string[] = [];
  let totalChars = 0;
  let truncated = false;

  for (const file of memoryFiles) {
    if (truncated) break;

    try {
      const content = await readFile(join(dir, file), 'utf-8');
      const header = `### ${basename(file, '.md')}`;

      if (totalChars + header.length + content.length > MAX_MEMORY_CHARS) {
        parts.push(`### ... (memory truncated at ${MAX_MEMORY_CHARS} chars)`);
        truncated = true;
        break;
      }

      parts.push(header);
      parts.push('');
      parts.push(content);
      parts.push('');
      totalChars += header.length + content.length + 4;
    } catch {
      // Skip unreadable files
    }
  }

  if (parts.length === 0) return '';

  const scopeLabel = scope === 'user' ? 'User' : scope === 'project' ? 'Project' : 'Workspace';
  return [
    `---`,
    `## Agent Memory (${scopeLabel})`,
    `The following persistent memories are available to this agent. Use Read to review them and Write/Edit to update them.`,
    '',
    ...parts,
    `---`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Tool augmentation for memory-enabled agents
// ---------------------------------------------------------------------------

/**
 * Tools that an agent needs when memory is enabled — allows reading and
 * updating memory files.
 */
const MEMORY_REQUIRED_TOOLS = ['read', 'write', 'edit'];

/**
 * Ensure the agent's tool allowlist includes the tools necessary to access
 * memory files. Only modifies the list when the agent uses an explicit
 * allowlist (not '*').
 */
export function augmentToolsForMemory(
  tools: string[] | '*',
): string[] | '*' {
  if (tools === '*') return '*';

  const toolSet = new Set(tools);
  let changed = false;
  for (const tool of MEMORY_REQUIRED_TOOLS) {
    if (!toolSet.has(tool)) {
      toolSet.add(tool);
      changed = true;
    }
  }

  return changed ? [...toolSet] : tools;
}

// ---------------------------------------------------------------------------
// Feature gate
// ---------------------------------------------------------------------------

/**
 * Check whether the automatic memory system is enabled.
 * Currently gated on CODER_MEMORY_ENABLED env var.
 * Future: read from settings.json.
 */
export function isAgentMemoryEnabled(): boolean {
  return (
    process.env.CODER_MEMORY_ENABLED === 'true' ||
    process.env.CODER_MEMORY_ENABLED === '1'
  );
}
