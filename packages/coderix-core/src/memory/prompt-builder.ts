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

/** Template showing the required frontmatter structure for memory files. */
const MEMORY_FRONTMATTER_EXAMPLE = [
  '```markdown',
  '---',
  'name: <kebab-case-slug>',
  'description: <single sentence summarizing what this memory captures>',
  `type: <one of ${MEMORY_TYPES.join(', ')}>`,
  '---',
  '',
  '<The memory content. For feedback or project memories, end with **Why:** and **How to apply:** lines.>',
  '```',
];

/** Memory type taxonomy — teaches the model what each category means. */
const TYPES_SECTION = [
  '## Categories of memory',
  '',
  'There are four kinds of persistent memory you can store:',
  '',
  '**user** — Facts about the person you are working with: their technical background,',
  '  current responsibilities, communication preferences, and domain expertise.',
  '  Use these to adapt your explanations and suggestions to the right level.',
  '',
  '**feedback** — Explicit guidance the user has given about your working style.',
  '  Covers both "please stop doing X" (corrections) and "that approach was spot on"',
  '  (confirmations). Always capture the *reasoning* so future you understands the',
  '  context: what happened, why it mattered, and when the rule applies.',
  '',
  '**project** — Context about the work that lives outside the codebase: deadlines,',
  '  decisions and their rationale, who owns what, upcoming changes. Anything you',
  '  would normally learn from standups or Slack rather than from reading the repo.',
  '  Convert time references like "next Tuesday" into calendar dates when saving.',
  '',
  '**reference** — Signposts to information in external tools and systems.',
  '  For example: which Linear project tracks a certain class of bugs, where the',
  '  oncall runbook lives, or which Slack channel discusses a particular service.',
  '',
];

/** Guardrails: what should never become a persistent memory. */
const WHAT_NOT_TO_SAVE_SECTION = [
  '## What should NOT be stored as memory',
  '',
  'Skip anything the model can discover by inspecting the project directly:',
  '- Code organization, naming conventions, architecture patterns → read the files.',
  '- Commit history, recent changes, or authorship → use `git log` / `git blame`.',
  '- Specific bugs and their fixes → the corrected code and the commit message are the record.',
  '- Anything already written in CODERIX.md → that file serves the same purpose.',
  '- Ephemeral task details: in-progress work, temporary state, current conversation context.',
  '- Debugging solutions or fix recipes → the fix is in the code; the commit message has context.',
  '',
  'This rule holds even when the user says "remember this for next time."',
  'If they ask you to memorize a weekly activity summary, push back: ask what',
  'was *unexpected* or *non-obvious* — that insight is the thing worth keeping.',
  '',
];

/** Guidelines for when the model should consult memory. */
const WHEN_TO_ACCESS_SECTION = [
  '## When to read memories',
  '- If the conversation touches a topic you have stored memories about, check them.',
  '- If the user references prior-conversation work or says "what do you remember"',
  '  or "recall", you MUST access memory.',
  '- If the user tells you to disregard memories: act as if none exist for this query.',
  '  Do not mention, compare against, or apply any recalled information.',
  '- Memories age. A stored fact reflects what was true *at the time it was written*.',
  '  Before relying on a memory, verify it against the file system or codebase.',
  '  When a memory disagrees with what you observe now, the current state wins —',
  '  and you should update or delete the memory to prevent future confusion.',
  '- A memory that names a specific function, file, or flag is a claim it existed',
  '  when the memory was written: verify before acting on it.',
];

/** Rules for safely acting on information retrieved from memory. */
const TRUSTING_RECALL_SECTION = [
  '## Verify before using recalled information',
  '',
  'A memory is a snapshot of how things looked at a past point in time.',
  'Before you recommend or act on a recalled fact:',
  '',
  '- Path mentioned in memory? Confirm the file is still there.',
  '- Function or CLI flag mentioned? Run a quick grep to check.',
  '- User asking you to do something based on the memory?',
  '  Verify first — memory is a hint, not a guarantee.',
  '',
  'When in doubt, trust what the code says over what a memory claims.',
  '',
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
    '# Persistent memory',
    '',
    `Your memory system lives at \`${memoryDir}\`. The directory is ready — write files there directly with the Write tool.`,
    '',
    'Use this system to carry knowledge across sessions: who the user is, how they',
    'like to work, important project context, and where to find information in',
    'external tools. Each new conversation starts with whatever you have built up.',
    '',
    'Respond to direct memory commands: if the user says "remember X", create a',
    'memory file for it. If they say "forget X", locate the corresponding file,',
    'delete it, and remove its line from the index.',
    '',
    ...TYPES_SECTION,
    ...WHAT_NOT_TO_SAVE_SECTION,
    '',
    '## Creating a memory',
    '',
    'Each memory requires two actions:',
    '',
    '1. Write the file — a `.md` file in the memory directory using this format:',
    '',
    ...MEMORY_FRONTMATTER_EXAMPLE,
    '',
    `2. Register it — add a one-line entry to \`${ENTRYPOINT_NAME}\` like this:`,
    `   \`- [Title](file.md) — short summary\``,
    '',
    `Keep \`${ENTRYPOINT_NAME}\` entries concise (one line, ~150 characters).`,
    `The index has a ${MAX_ENTRYPOINT_LINES}-line limit; entries beyond that are truncated.`,
    'Never write full memory content into the index file — it is a table of contents.',
    '',
    'Additional rules for memory files:',
    '- Group related information by topic, not by date.',
    '- Always check if a memory already covers the topic before creating a new file.',
    '- When a stored fact becomes incorrect, edit or remove it immediately.',
    '- Keep the frontmatter fields (name, description, type) accurate as content evolves.',
    '',
    ...WHEN_TO_ACCESS_SECTION,
    '',
    ...TRUSTING_RECALL_SECTION,
    '',
    '## Memory vs. other tools',
    '',
    'Memory persists across sessions. For information that only matters within the',
    'current conversation, use the appropriate session-scoped tool instead:',
    '- Plans (EnterPlanMode / ExitPlanMode): for design decisions and implementation strategy.',
    '- Tasks (TodoWrite / TaskCreate): for tracking progress and to-do items in this session.',
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
