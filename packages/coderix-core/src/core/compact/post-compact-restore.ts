/**
 * post-compact-restore.ts — Re-inject critical context after compaction.
 *
 * After LLM compaction prunes old messages, key context must be restored
 * so the model doesn't lose awareness of:
 * - Recently read files (codebase context)
 * - Active plan mode state
 * - Invoked skill content
 * - CODERIX.md project/user instructions
 * - Memory file context
 *
 * Each restoration type has its own token budget to prevent the restored
 * context from immediately consuming the space freed by compaction.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Message } from '../types.js';
import type { ReadFileTracker } from '../read-file-tracker.js';
import {
  POST_COMPACT_MAX_FILES,
  POST_COMPACT_TOKEN_BUDGET,
  POST_COMPACT_MAX_TOKENS_PER_FILE,
  POST_COMPACT_MAX_TOKENS_PER_SKILL,
  POST_COMPACT_SKILLS_TOKEN_BUDGET,
} from './compact-types.js';
import { countTokens } from '../token-counter.js';

// ---------------------------------------------------------------------------
// Post-compact file restoration
// ---------------------------------------------------------------------------

/**
 * Build file content attachment messages for the N most recently read files.
 *
 * Skips files whose content is already visible in the preserved messages
 * (deduplication via Read tool result paths).
 *
 * Each file is capped at POST_COMPACT_MAX_TOKENS_PER_FILE tokens.
 * Total budget across all files: POST_COMPACT_TOKEN_BUDGET.
 */
export function createPostCompactFileAttachments(
  readFileTracker: ReadFileTracker | undefined,
  preservedMessages: Message[] = [],
): Message[] {
  if (!readFileTracker) return [];

  // Collect file paths already visible in preserved messages
  const visiblePaths = collectVisibleFilePaths(preservedMessages);

  const recentFiles = readFileTracker.getRecent(POST_COMPACT_MAX_FILES);
  const attachments: Message[] = [];
  let totalTokens = 0;

  for (const entry of recentFiles) {
    if (totalTokens >= POST_COMPACT_TOKEN_BUDGET) break;
    if (visiblePaths.has(entry.path)) continue;

    const content = truncateToTokenBudget(
      entry.content,
      POST_COMPACT_MAX_TOKENS_PER_FILE,
    );

    const tokenCost = countTokens(content);
    if (totalTokens + tokenCost > POST_COMPACT_TOKEN_BUDGET) {
      // Try shorter truncation
      const remaining = POST_COMPACT_TOKEN_BUDGET - totalTokens;
      if (remaining < 500) break; // not worth it
      const shortContent = truncateToTokenBudget(content, remaining);
      totalTokens += countTokens(shortContent);
      attachments.push({
        role: 'user' as const,
        content: buildFileAttachment(entry.path, shortContent, true),
      });
      break;
    }

    totalTokens += tokenCost;
    attachments.push({
      role: 'user' as const,
      content: buildFileAttachment(entry.path, content, false),
    });
  }

  return attachments;
}

// ---------------------------------------------------------------------------
// Plan mode restoration
// ---------------------------------------------------------------------------

/**
 * Build a plan mode reminder attachment if plan mode is active.
 */
export function createPlanModeAttachmentIfNeeded(
  planModeState: { planFilePath: string } | null | undefined,
): Message[] {
  if (!planModeState) return [];

  return [
    {
      role: 'user' as const,
      content:
        `[System: You are still in plan mode. The plan file is at ${planModeState.planFilePath}. ` +
        'You must not make any edits, run any non-readonly tools (including changing configs or making commits), ' +
        'or otherwise make any changes to the system. Use ExitPlanMode when your plan is ready.]',
    },
  ];
}

/**
 * Build a plan file content attachment for the current plan.
 */
export function createPlanAttachmentIfNeeded(
  planModeState: { planFilePath: string } | null | undefined,
): Message[] {
  if (!planModeState) return [];

  try {
    if (!existsSync(planModeState.planFilePath)) return [];

    const content = readFileSync(planModeState.planFilePath, 'utf-8');
    if (!content.trim()) return [];

    return [
      {
        role: 'user' as const,
        content: `[Current plan file content from ${planModeState.planFilePath}:\n\n${truncateToTokenBudget(content, POST_COMPACT_MAX_TOKENS_PER_FILE)}]`,
      },
    ];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Skill restoration
// ---------------------------------------------------------------------------

/**
 * Build skill content attachment if a skill was invoked.
 */
export function createSkillAttachmentIfNeeded(
  skillContent: string | undefined,
  skillName: string | undefined,
): Message[] {
  if (!skillContent || !skillName) return [];

  const truncated = truncateToTokenBudget(
    skillContent,
    POST_COMPACT_MAX_TOKENS_PER_SKILL,
  );

  return [
    {
      role: 'user' as const,
      content: `[Skill "${skillName}" was active before compaction. Content:\n\n${truncated}]`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Context restoration (CODERIX.md, memory)
// ---------------------------------------------------------------------------

/**
 * Build CODERIX.md context restoration message.
 */
export function createCoderixMdAttachment(
  projectCoderixMd: string | null,
  userCoderixMd: string | null,
): Message[] {
  const parts: string[] = [];

  if (projectCoderixMd) {
    parts.push(`[Project instructions from CODERIX.md:\n${projectCoderixMd.slice(0, 2000)}]`);
  }
  if (userCoderixMd) {
    parts.push(`[User instructions from ~/.coderix/CODERIX.md:\n${userCoderixMd.slice(0, 2000)}]`);
  }

  if (parts.length === 0) return [];

  return [
    {
      role: 'user' as const,
      content: parts.join('\n\n'),
    },
  ];
}

// ---------------------------------------------------------------------------
// Collect all post-compact attachments
// ---------------------------------------------------------------------------

export interface PostCompactRestoreOptions {
  readFileTracker?: ReadFileTracker;
  preservedMessages?: Message[];
  planModeState?: { planFilePath: string } | null;
  skillContent?: string;
  skillName?: string;
  projectCoderixMd?: string | null;
  userCoderixMd?: string | null;
}

/**
 * Collect all post-compact restoration attachments.
 */
export function collectPostCompactAttachments(
  options: PostCompactRestoreOptions,
): Message[] {
  const attachments: Message[] = [];

  // File restoration
  attachments.push(
    ...createPostCompactFileAttachments(
      options.readFileTracker,
      options.preservedMessages,
    ),
  );

  // Plan mode
  attachments.push(
    ...createPlanAttachmentIfNeeded(options.planModeState),
  );
  attachments.push(
    ...createPlanModeAttachmentIfNeeded(options.planModeState),
  );

  // Skill
  attachments.push(
    ...createSkillAttachmentIfNeeded(
      options.skillContent,
      options.skillName,
    ),
  );

  // CODERIX.md context
  attachments.push(
    ...createCoderixMdAttachment(
      options.projectCoderixMd ?? null,
      options.userCoderixMd ?? null,
    ),
  );

  return attachments;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Collect file paths visible in preserved messages via Read tool results.
 */
function collectVisibleFilePaths(messages: Message[]): Set<string> {
  const paths = new Set<string>();
  const normalized = new Set<string>();

  for (const msg of messages) {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;

    for (const block of msg.content) {
      if (block.type !== 'tool_result') continue;
      if (typeof block.content !== 'string') continue;

      // Look for file paths in the "Reading from:" prefix from Read tool
      const lines = block.content.split('\n');
      for (const line of lines) {
        // Match patterns like "Reading from: /path/to/file" or "File: /path"
        const match = line.match(
          /(?:Reading from|File|Path):\s*(.+)/i,
        );
        if (match?.[1]) {
          const p = match[1].trim();
          paths.add(p);
          normalized.add(p.replace(/\\/g, '/'));
        }
      }
    }
  }

  return normalized;
}

/**
 * Truncate content to fit within a token budget using character estimation.
 * (4 chars ≈ 1 token for English text).
 */
function truncateToTokenBudget(content: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (content.length <= maxChars) return content;
  return content.slice(0, maxChars) + '\n...[truncated]';
}

function buildFileAttachment(
  path: string,
  content: string,
  truncated: boolean,
): string {
  return `[Recently read file: ${path}${truncated ? ' (truncated)' : ''}\n\n${content}]`;
}
