/**
 * Memory prompt builder — constructs the system prompt section that teaches
 * the model how to use the persistent memory system.
 *
 * The prompt covers:
 *   1. WHERE memories are stored (directory path)
 *   2. WHAT types of memory exist (user/feedback/project/reference)
 *   3. WHAT NOT to save (derivable from code/git/CODERIX.md)
 *   4. HOW to save (two-step: Write file + update MEMORY.md index)
 *   5. WHEN to access memories
 *   6. HOW to verify memory claims before acting on them
 */

import {
  type MemoryConfig,
  type MemoryIndexEntry,
  type MemoryType,
  MEMORY_TYPES,
  ENTRYPOINT_NAME,
  MAX_ENTRYPOINT_LINES,
  MAX_ENTRYPOINT_BYTES,
} from './types.js';
import { getMemoryDir, getMemoryIndexPath } from './memory-directory.js';
import { loadIndex, parseIndexContent } from './memory-index.js';
import { ensureMemoryDirExists } from './memory-directory.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function formatFileSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes}B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)}KB`;
  return `${(bytes / 1_048_576).toFixed(1)}MB`;
}

// ---------------------------------------------------------------------------
// Constants (prompt text blocks)
// ---------------------------------------------------------------------------

/** The frontmatter format example shown to the model. */
const MEMORY_FRONTMATTER_EXAMPLE = [
  '```markdown',
  '---',
  'name: {{memory name}}',
  'description: {{one-line description — used to decide relevance in future conversations, so be specific}}',
  `type: {{${MEMORY_TYPES.join(', ')}}}`,
  '---',
  '',
  '{{memory content — for feedback/project types, structure as: rule/fact, then **Why:** and **How to apply:** lines}}',
  '```',
];

/** Types of memory section — individual (single directory) variant. */
const TYPES_SECTION = [
  '## Types of memory',
  '',
  '<types>',
  '<type>',
  '    <name>user</name>',
  "    <description>The user's role, goals, preferences, responsibilities, and knowledge. Use these to tailor your behavior to the user.</description>",
  '</type>',
  '<type>',
  '    <name>feedback</name>',
  '    <description>Guidance from the user about how to approach work — what to avoid and what to keep doing. Record from failure AND success. Include *why* so you can judge edge cases later. Structure content as: rule/fact, then **Why:** and **How to apply:** lines.</description>',
  '</type>',
  '<type>',
  '    <name>project</name>',
  '    <description>Information about ongoing work, goals, initiatives, bugs, or incidents not derivable from code or git history. Convert relative dates to absolute dates when saving (e.g., "Thursday" → "2026-03-05").</description>',
  '</type>',
  '<type>',
  '    <name>reference</name>',
  '    <description>Pointers to external systems where information can be found (e.g., Linear projects, Slack channels, Grafana dashboards).</description>',
  '</type>',
  '</types>',
  '',
];

/** What NOT to save in memory. */
const WHAT_NOT_TO_SAVE_SECTION = [
  '## What NOT to save in memory',
  '',
  '- Code patterns, conventions, architecture, file paths, or project structure — these can be derived by reading the current project state.',
  '- Git history, recent changes, or who-changed-what — `git log` / `git blame` are authoritative.',
  '- Debugging solutions or fix recipes — the fix is in the code; the commit message has the context.',
  '- Anything already documented in CODERIX.md files.',
  '- Ephemeral task details: in-progress work, temporary state, current conversation context.',
  '',
  'These exclusions apply even when the user explicitly asks you to save. If they ask you to save a PR list or activity summary, ask what was *surprising* or *non-obvious* about it — that is the part worth keeping.',
];

/** When to access memories. */
const WHEN_TO_ACCESS_SECTION = [
  '## When to access memories',
  '- When memories seem relevant, or the user references prior-conversation work.',
  '- You MUST access memory when the user explicitly asks you to check, recall, or remember.',
  '- If the user says to *ignore* or *not use* memory: proceed as if MEMORY.md were empty. Do not apply remembered facts, cite, compare against, or mention memory content.',
  '- Memory records can become stale over time. Use memory as context for what was true at a given point in time. Before answering the user or building assumptions based solely on information in memory records, verify that the memory is still correct and up-to-date by reading the current state of the files or resources. If a recalled memory conflicts with current information, trust what you observe now — and update or remove the stale memory rather than acting on it.',
];

/** Trusting recall — verify before recommending. */
const TRUSTING_RECALL_SECTION = [
  '## Before recommending from memory',
  '',
  'A memory that names a specific function, file, or flag is a claim that it existed *when the memory was written*. It may have been renamed, removed, or never merged. Before recommending it:',
  '',
  '- If the memory names a file path: check the file exists.',
  '- If the memory names a function or flag: grep for it.',
  '- If the user is about to act on your recommendation (not just asking about history), verify first.',
  '',
  '"The memory says X exists" is not the same as "X exists now."',
  '',
  'A memory that summarizes repo state (activity logs, architecture snapshots) is frozen in time. If the user asks about *recent* or *current* state, prefer `git log` or reading the code over recalling the snapshot.',
];

// ---------------------------------------------------------------------------
// Truncation helpers
// ---------------------------------------------------------------------------

/**
 * Truncate MEMORY.md content to the line AND byte caps, appending a warning
 * that names which cap fired.
 */
function truncateEntrypointContent(raw: string): string {
  const trimmed = raw.trim();
  const contentLines = trimmed.split('\n');
  const lineCount = contentLines.length;
  const byteCount = trimmed.length;

  if (lineCount <= MAX_ENTRYPOINT_LINES && byteCount <= MAX_ENTRYPOINT_BYTES) {
    return trimmed;
  }

  let truncated = contentLines.slice(0, MAX_ENTRYPOINT_LINES).join('\n');

  if (truncated.length > MAX_ENTRYPOINT_BYTES) {
    const cutAt = truncated.lastIndexOf('\n', MAX_ENTRYPOINT_BYTES);
    truncated = truncated.slice(0, cutAt > 0 ? cutAt : MAX_ENTRYPOINT_BYTES);
  }

  const reason =
    byteCount > MAX_ENTRYPOINT_BYTES
      ? `${formatFileSize(byteCount)} (limit: ${formatFileSize(MAX_ENTRYPOINT_BYTES)}) — index entries are too long`
      : `${lineCount} lines (limit: ${MAX_ENTRYPOINT_LINES})`;

  return (
    truncated +
    `\n\n> WARNING: ${ENTRYPOINT_NAME} is ${reason}. Only part of it was loaded. Keep index entries to one line under ~200 chars; move detail into topic files.`
  );
}

// ---------------------------------------------------------------------------
// Main prompt builder
// ---------------------------------------------------------------------------

/**
 * Build the memory system prompt section.
 *
 * @param cwd - Current working directory for resolving memory paths
 * @param config - Resolved memory configuration
 * @returns The full memory prompt string, or null if memory is disabled
 */
export async function loadMemoryPrompt(
  cwd: string,
  config: MemoryConfig,
): Promise<string | null> {
  if (!config.enabled) return null;

  // Ensure directory exists so the model can write directly
  const memoryDir = ensureMemoryDirExists(cwd);
  const indexPath = getMemoryIndexPath(cwd);

  // Load existing MEMORY.md
  const { entries, wasTruncated } = await loadIndex(cwd);

  // Build the instruction lines
  const lines: string[] = [
    '# Memory',
    '',
    `You have a persistent, file-based memory system at \`${memoryDir}\`. This directory already exists — write to it directly with the Write tool (do not run mkdir or check for its existence).`,
    '',
    "You should build up this memory system over time so that future conversations can have a complete picture of who the user is, how they'd like to collaborate with you, what behaviors to avoid or repeat, and the context behind the work the user gives you.",
    '',
    'If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.',
    '',
    ...TYPES_SECTION,
    ...WHAT_NOT_TO_SAVE_SECTION,
    '',
    '## How to save memories',
    '',
    'Saving a memory is a two-step process:',
    '',
    '**Step 1** — write the memory to its own file (e.g., `user_role.md`, `feedback_testing.md`) using this frontmatter format:',
    '',
    ...MEMORY_FRONTMATTER_EXAMPLE,
    '',
    `**Step 2** — add a pointer to that file in \`${ENTRYPOINT_NAME}\`. \`${ENTRYPOINT_NAME}\` is an index, not a memory — each entry should be one line, under ~150 characters: \`- [Title](file.md) — one-line hook\`. It has no frontmatter. Never write memory content directly into \`${ENTRYPOINT_NAME}\`.`,
    '',
    `- \`${ENTRYPOINT_NAME}\` is always loaded into your conversation context — lines after ${MAX_ENTRYPOINT_LINES} will be truncated, so keep the index concise`,
    '- Keep the name, description, and type fields in memory files up-to-date with the content',
    '- Organize memory semantically by topic, not chronologically',
    '- Update or remove memories that turn out to be wrong or outdated',
    '- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.',
    '',
    ...WHEN_TO_ACCESS_SECTION,
    '',
    ...TRUSTING_RECALL_SECTION,
    '',
    '## Memory and other forms of persistence',
    'Memory is one of several persistence mechanisms available to you as you assist the user in a given conversation. The distinction is often that memory can be recalled in future conversations and should not be used for persisting information that is only useful within the scope of the current conversation.',
    '- When to use or update a plan instead of memory: If you are about to start a non-trivial implementation task and would like to reach alignment with the user on your approach you should use a Plan rather than saving this information to memory. Similarly, if you already have a plan within the conversation and you have changed your approach persist that change by updating the plan rather than saving a memory.',
    '- When to use or update tasks instead of memory: When you need to break your work in current conversation into discrete steps or keep track of your progress use tasks instead of saving to memory. Tasks are great for persisting information about the work that needs to be done in the current conversation, but memory should be reserved for information that will be useful in future conversations.',
    '',
  ];

  // Inject MEMORY.md content or empty-state message
  lines.push(`## ${ENTRYPOINT_NAME}`);

  if (entries.length > 0) {
    // Show current index contents
    const shown = entries.slice(0, 50);
    const indexLines = shown.map(
      e =>
        `- [${e.name}](${e.path})${e.description ? ` — ${e.description}` : ''}`,
    );

    lines.push('');
    lines.push(...indexLines);

    if (wasTruncated) {
      lines.push(
        '',
        `> WARNING: ${ENTRYPOINT_NAME} exceeds limits (${MAX_ENTRYPOINT_LINES} lines / ${MAX_ENTRYPOINT_BYTES} bytes). Only part of it was loaded.`,
      );
    }

    if (entries.length > 50) {
      lines.push(
        '',
        `> Showing 50 of ${entries.length} memories. Use Read to browse all files in the memory directory.`,
      );
    }
  } else {
    lines.push('');
    lines.push(
      `Your ${ENTRYPOINT_NAME} is currently empty. When you save new memories, they will appear here.`,
    );
  }

  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format the current memory index as a compact listing for injection.
 * Used by recall when surfacing context about what memories exist.
 */
export function formatMemoryContext(
  entries: MemoryIndexEntry[],
  maxEntries: number = 50,
): string {
  if (entries.length === 0) return '';

  const shown = entries.slice(0, maxEntries);
  const lines = shown.map(
    e =>
      `- [${e.name}](${e.path})${e.description ? ` — ${e.description}` : ''}`,
  );

  if (entries.length > maxEntries) {
    lines.push(
      `> Showing ${maxEntries} of ${entries.length} memories. Use Read to browse all.`,
    );
  }

  return lines.join('\n');
}
