/**
 * Auto-memory extraction engine.
 *
 * Runs after each query loop (fire-and-forget) to extract durable memories
 * from the conversation. Uses a direct LLM call (not a full forked agent)
 * to keep the extraction lean and provider-agnostic.
 *
 * The extraction agent is given:
 *   - The conversation messages since the last extraction
 *   - The existing memory file manifest
 *   - Restricted instructions: only extract truly new, non-derivable information
 *
 * Based on the claude-code-best extractMemories pattern, adapted for
 * Coderix's provider-agnostic architecture.
 */

import type { Message } from '../core/types.js';
import type { MemoryConfig, MemoryEntry } from './types.js';
import { getMemoryDir, ensureMemoryDirExists } from './memory-directory.js';
import { scanMemoryFiles, formatMemoryManifest } from './frontmatter.js';
import { loadIndex } from './memory-index.js';

function createAbortController(): AbortController {
  return new AbortController();
}

// ---------------------------------------------------------------------------
// Extraction state (closure-scoped singleton)
// ---------------------------------------------------------------------------

interface PendingExtraction {
  messages: Message[];
  cwd: string;
  config: MemoryConfig;
  callModel: ((params: {
    system: string;
    messages: Array<{ role: string; content: string }>;
    max_tokens: number;
  }) => Promise<{ text: string; usage?: { input_tokens: number; output_tokens: number } }>) | null;
}

let isExtracting = false;
let lastExtractedMessageUuid: string | undefined;
let turnsSinceLastExtraction = 0;
let pendingContext: PendingExtraction | null = null;
const inFlightExtractions = new Set<Promise<void>>();

// ---------------------------------------------------------------------------
// Throttle check
// ---------------------------------------------------------------------------

function shouldExtract(
  config: MemoryConfig,
  messages: Message[],
): boolean {
  if (!config.enabled || !config.autoExtract) return false;

  turnsSinceLastExtraction++;

  if (turnsSinceLastExtraction < config.extractEveryNTurns) {
    return false;
  }

  // Check if main agent wrote to memory files this turn
  // (mutual exclusion: skip if model already saved memories)
  const lastMessage = messages.at(-1);
  if (!lastMessage || lastMessage.role !== 'assistant') return false;

  // Check if the last assistant turn had no tool calls (natural break)
  const content = lastMessage.content;
  if (Array.isArray(content)) {
    const hasToolCalls = content.some(b => b.type === 'tool_use');
    if (hasToolCalls) {
      // Only extract when the model is done with tools
      return false;
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Message counting
// ---------------------------------------------------------------------------

/**
 * Count model-visible messages since the last extraction UUID.
 */
function countNewMessages(
  messages: Message[],
  sinceUuid: string | undefined,
): number {
  if (!sinceUuid) return messages.filter(m => m.role === 'user' || m.role === 'assistant').length;

  let found = false;
  let count = 0;
  for (const m of messages) {
    if (!found) {
      if ((m as any).uuid === sinceUuid) found = true;
      continue;
    }
    if (m.role === 'user' || m.role === 'assistant') count++;
  }

  // If UUID not found (compaction removed it), count everything
  if (!found) {
    return messages.filter(m => m.role === 'user' || m.role === 'assistant').length;
  }

  return count;
}

// ---------------------------------------------------------------------------
// Extraction prompt builder
// ---------------------------------------------------------------------------

function buildExtractionPrompt(
  newMessageCount: number,
  existingManifest: string,
): string {
  return [
    `You are extracting durable memories from the conversation above. Review the last ${newMessageCount} messages and extract any NEW information worth persisting across future sessions.`,
    '',
    '## What to extract',
    '- User preferences, corrections, or explicit requests about how to work',
    '- Project context not derivable from code (deadlines, decisions, rationale)',
    '- Pointers to external systems or resources mentioned',
    '- Feedback the user gave about your behavior',
    '',
    '## What NOT to extract',
    '- Code patterns, conventions, or file paths (derivable from current code)',
    '- Debugging steps or fix recipes (the code has the fix)',
    '- Information already in the existing memories below',
    '- Ephemeral task details or in-progress work',
    '',
    '## Existing memories (do not duplicate)',
    existingManifest || '(no existing memories)',
    '',
    '## Response format',
    'Return a JSON array of memory objects to create. Each object must have:',
    '- name: kebab-case filename (e.g., "use-bun-not-npm")',
    '- description: one-line summary for relevance matching',
    '- type: one of "user", "feedback", "project", "reference"',
    '- content: the full memory text (include **Why:** and **How to apply:** lines for feedback/project)',
    '',
    'If nothing new to extract, return an empty array.',
    '',
    '```json',
    '[{"name": "...", "description": "...", "type": "user", "content": "..."}]',
    '```',
    '',
    'Only return JSON — no other text.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Extraction execution
// ---------------------------------------------------------------------------

interface ExtractedMemory {
  name: string;
  description: string;
  type: 'user' | 'feedback' | 'project' | 'reference';
  content: string;
}

async function runExtraction(
  context: PendingExtraction,
): Promise<number> {
  const { messages, cwd, config, callModel } = context;
  if (!callModel) return 0;

  const memoryDir = ensureMemoryDirExists(cwd);
  const newCount = countNewMessages(messages, lastExtractedMessageUuid);
  if (newCount === 0) return 0;

  // Scan existing memories
  const ac = createAbortController();
  const existing = await scanMemoryFiles(memoryDir, 200, ac.signal);
  const manifest = formatMemoryManifest(existing);

  // Build prompt
  const systemPrompt = buildExtractionPrompt(newCount, manifest);

  // Collect conversation messages as context
  const conversationText = messages
    .slice(-Math.min(newCount * 2, messages.length))
    .map(m => {
      const role = m.role.toUpperCase();
      const content =
        typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content)
            ? m.content
                .filter(b => b.type === 'text')
                .map(b => (b as { text: string }).text)
                .join('\n')
            : '';
      return `[${role}] ${content.slice(0, 2000)}`;
    })
    .join('\n\n');

  try {
    const result = await callModel({
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: `Conversation transcript extracts:\n\n${conversationText}`,
        },
      ],
      max_tokens: 2000,
    });

    // Parse JSON response
    const jsonMatch = result.text.match(/```json\s*([\s\S]*?)\s*```/) ?? [null, result.text];
    const jsonText = (jsonMatch[1] ?? result.text).trim();

    let memories: ExtractedMemory[] = [];
    try {
      memories = JSON.parse(jsonText);
      if (!Array.isArray(memories)) memories = [];
    } catch {
      // If JSON parsing fails, try to extract just the array part
      const arrMatch = result.text.match(/\[\s*\{[\s\S]*\}\s*\]/);
      if (arrMatch) {
        try {
          memories = JSON.parse(arrMatch[0]);
        } catch {
          return 0;
        }
      } else {
        return 0;
      }
    }

    if (memories.length === 0) return 0;

    // Write memory files
    let written = 0;
    const { writeFile, mkdir } = await import('fs/promises');
    const { join } = await import('path');
    const { loadIndex, addIndexEntry } = await import('./memory-index.js');

    for (const mem of memories) {
      // Validate
      if (!mem.name || !mem.description || !mem.content) continue;
      const validTypes = ['user', 'feedback', 'project', 'reference'];
      if (!validTypes.includes(mem.type)) continue;

      // Sanitize filename
      const safeName = mem.name.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 100);
      const filePath = join(memoryDir, `${safeName}.md`);

      // Create memory file
      const frontmatterBlock = [
        '---',
        `name: ${mem.name}`,
        `description: ${mem.description}`,
        `type: ${mem.type}`,
        '---',
        '',
        mem.content,
      ].join('\n');

      try {
        await writeFile(filePath, frontmatterBlock + '\n', 'utf-8');
        written++;

        // Update index
        await addIndexEntry(
          {
            name: mem.name,
            path: `${safeName}.md`,
            description: mem.description,
            type: mem.type,
          },
          cwd,
        );
      } catch {
        // Skip files we can't write
      }
    }

    return written;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the memory extraction system.
 * Must be called once at startup. Idempotent.
 */
export function initExtractMemories(): void {
  // Reset state on init
  isExtracting = false;
  lastExtractedMessageUuid = undefined;
  turnsSinceLastExtraction = 0;
  pendingContext = null;
  inFlightExtractions.clear();
}

/**
 * Trigger memory extraction after a query loop completes.
 *
 * Fire-and-forget — does not block the main agent. Handles:
 *   - Throttling (every N turns)
 *   - Mutual exclusion (skip if main agent wrote memories)
 *   - Coalescing (buffer pending while extraction runs)
 *
 * @param messages - Full conversation messages
 * @param cwd - Working directory
 * @param config - Memory configuration
 * @param callModel - Function to call the LLM (from QueryEngine)
 */
export function executeExtractMemories(
  messages: Message[],
  cwd: string,
  config: MemoryConfig,
  callModel: PendingExtraction['callModel'],
): void {
  if (!config.enabled || !config.autoExtract) return;

  if (!shouldExtract(config, messages)) return;
  turnsSinceLastExtraction = 0;

  // Update cursor
  const lastMessage = messages.at(-1);
  if (lastMessage && (lastMessage as any).uuid) {
    lastExtractedMessageUuid = (lastMessage as any).uuid;
  }

  const context: PendingExtraction = {
    messages,
    cwd,
    config,
    callModel,
  };

  // If extraction is in progress, buffer for trailing run
  if (isExtracting) {
    pendingContext = context;
    return;
  }

  isExtracting = true;
  const promise: Promise<void> = runExtraction(context)
    .then(() => {})
    .catch(() => {})
    .finally(() => {
      isExtracting = false;

      // Process coalesced pending extraction
      const pending = pendingContext;
      pendingContext = null;
      if (pending) {
        isExtracting = true;
        runExtraction(pending)
          .then(() => {})
          .catch(() => {})
          .finally(() => {
            isExtracting = false;
          });
      }
    });

  inFlightExtractions.add(promise);
  promise.finally(() => {
    inFlightExtractions.delete(promise);
  });
}

/**
 * Drain all in-flight extraction promises.
 * Called during graceful shutdown.
 */
export async function drainPendingExtraction(
  timeoutMs: number = 30_000,
): Promise<void> {
  if (inFlightExtractions.size === 0) return;

  await Promise.race([
    Promise.all(inFlightExtractions).catch(() => {}),
    new Promise<void>(resolve => setTimeout(resolve, timeoutMs)),
  ]);
}

// ---------------------------------------------------------------------------
// Testing helpers
// ---------------------------------------------------------------------------

export function _resetExtractionState(): void {
  isExtracting = false;
  lastExtractedMessageUuid = undefined;
  turnsSinceLastExtraction = 0;
  pendingContext = null;
  inFlightExtractions.clear();
}

export function _getExtractionState() {
  return {
    isExtracting,
    turnsSinceLastExtraction,
    hasPending: pendingContext !== null,
    inFlightCount: inFlightExtractions.size,
  };
}
