import { truncateToTokenLimit, truncateToTokenLimitFromEnd, countTokens } from '../core/token-counter.js';
import type { Message, ContentBlock, AgentSpawnContext } from '../core/types.js';
import type { SystemPrompt, SystemPromptAssembler } from '../core/system-prompt.js';
import { ToolRegistry } from '../core/tool-registry.js';
import { PermissionEngine } from '../core/permission.js';
import { PermissionMode } from '../core/types.js';
import { SessionManager } from '../core/session.js';
import { CheckpointManager } from '../core/checkpoint.js';
import { query } from '../core/query.js';
import { removeAgentWorktree, hasWorktreeChanges } from '../utils/worktree.js';

export const DEFAULT_MAX_TURNS = 200;
export const DEFAULT_CONTEXT_BUDGET = 120_000;
export const DEFAULT_MAX_CONCURRENCY = 8;

export function shortId(): string {
  return Math.random().toString(36).slice(2, 10);
}

const TURN_1K = 1000;
const TURN_2K = 2000;
const TURN_32K = 32000;
const OVERALL_MAX_TOKENS = 32000;

export function compressTranscript(messages: Message[]): string {
  // Step 1: extract text from each assistant message (last 60)
  const turns: string[] = [];
  for (const msg of messages.slice(-60)) {
    if (msg.role !== 'assistant') continue;
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    const texts: string[] = [];
    for (const block of blocks) {
      if (block.type === 'text') {
        const text = (block as { text?: string }).text ?? '';
        if (text) texts.push(text);
      }
    }
    if (texts.length > 0) turns.push(texts.join('\n'));
  }

  if (turns.length === 0) return '(sub-agent produced no text output)';

  // Step 2: per-turn truncation by distance from end (token-based)
  const truncated = turns.map((turn, i) => {
    const distFromEnd = turns.length - 1 - i;
    let maxTokens: number;
    if (distFromEnd === 0)        maxTokens = TURN_32K; // last turn: 32K tokens
    else if (distFromEnd <= 5)    maxTokens = TURN_2K;  // turns 2-6 from end: 2K tokens
    else                          maxTokens = TURN_1K;  // turn 7+: 1K tokens
    if (countTokens(turn) <= maxTokens) return turn;
    return truncateToTokenLimit(turn, maxTokens);
  });

  // Step 3: overall -- keep last 16K tokens
  const body = truncated.join('\n\n');
  if (countTokens(body) <= OVERALL_MAX_TOKENS) return body;
  return truncateToTokenLimitFromEnd(body, OVERALL_MAX_TOKENS);
}

export interface ToolCallSummary {
  name: string;
  input: string;
  state: string;
}

export function extractToolCalls(messages: Message[]): ToolCallSummary[] {
  const tools: ToolCallSummary[] = [];
  for (const msg of messages.slice(-50)) {
    if (msg.role !== 'assistant') continue;
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    for (const block of blocks) {
      if (block.type === 'tool_use') {
        const b = block as { name?: string; input?: Record<string, unknown>; id?: string };
        const inputStr = b.input ? JSON.stringify(b.input) : '';
        tools.push({ name: b.name ?? 'unknown', input: inputStr, state: 'done' });
      }
    }
  }
  return tools;
}

/**
 * Enrich an agent definition's system prompt with environment info from the
 * assembler's worker role output.
 */
export async function enrichAgentPrompt(
  agentPrompt: string,
  assembler: SystemPromptAssembler,
): Promise<string> {
  try {
    const workerPrompt = await assembler.assemble({
      cwd: process.cwd(),
      permissionMode: 'auto',
      agentRole: 'worker',
    });
    const envPart = workerPrompt.parts.find(p => p.name === 'env_info');
    const permPart = workerPrompt.parts.find(p => p.name === 'permission_mode');
    const extra = [envPart?.content, permPart?.content].filter(Boolean).join('\n\n');
    if (extra) {
      return agentPrompt + '\n\n' + extra;
    }
  } catch {
    // If assembly fails, fall back to the raw agent prompt
  }
  return agentPrompt;
}

// ---------------------------------------------------------------------------
// Core runner — shared by Agent and TeamAgent tools
// ---------------------------------------------------------------------------

export interface RunAgentParams {
  agentId: string;
  agentType: string;
  prompt: string;
  agentSpawn: AgentSpawnContext;
  systemPromptText: string;
  effectiveModel: string | undefined;
  effectiveMaxTurns: number;
  effectiveContextBudget: number;
  initialMessages: Message[];
  subToolRegistry: ToolRegistry;
  subAbortController: AbortController;
  cwd: string;
  /** Enable Anthropic prompt cache annotations (for fork agents). */
  enableCacheControl?: boolean;
}

export async function runAgentLoop(params: RunAgentParams): Promise<{
  agentId: string;
  agentType: string;
  assistantTurnCount: number;
  toolCount: number;
  transcript: Message[];
  startTime: number;
  error?: string;
  tokenUsage?: { inputTokens: number; outputTokens: number; cacheCreationInputTokens: number; cacheReadInputTokens: number; totalCost: number };
}> {
  const {
    agentId, agentType, prompt, agentSpawn,
    systemPromptText, effectiveModel, effectiveMaxTurns, effectiveContextBudget,
    initialMessages, subToolRegistry, subAbortController, cwd, enableCacheControl,
  } = params;

  const subPermissionEngine = new PermissionEngine(cwd);
  subPermissionEngine.setMode(PermissionMode.AUTO);

  const subSessionManager = new SessionManager(true);
  subSessionManager.create({
    title: `Sub-agent: ${agentType}`,
    cwd,
    model: effectiveModel,
    parentSessionId: agentSpawn.sessionManager.getActive()?.id,
  });

  const subCheckpointManager = new CheckpointManager();

  const workerPrompt: SystemPrompt = {
    prompt: systemPromptText,
    parts: [{ name: `agent-${agentType}`, content: systemPromptText, priority: 0 }],
  };

  const startTime = Date.now();
  let assistantTurnCount = 0;
  let messageCount = 0;
  let toolCount = 0;
  const transcript: Message[] = [...initialMessages];
  const accumulatedLiveCalls: Array<{ name: string; input: string; state: string }> = [];

  // Share transcript reference with registry so the TUI can poll it
  // without us creating O(n^2) copies on every message.
  agentSpawn.subAgentRegistry.update(agentId, { transcript });

  try {
    const generator = query({
      sessionId: subSessionManager.getActive()?.id ?? agentId,
      cwd,
      messages: initialMessages,
      systemPrompt: workerPrompt,
      toolRegistry: subToolRegistry,
      permissionEngine: subPermissionEngine,
      sessionManager: subSessionManager,
      checkpointManager: subCheckpointManager,
      abortController: subAbortController,
      maxTurns: effectiveMaxTurns,
      contextBudget: effectiveContextBudget,
      compactThreshold: 0.85,
      maxToolConcurrency: DEFAULT_MAX_CONCURRENCY,
      callModel: agentSpawn.callModel,
      hookManager: agentSpawn.hookManager,
      subAgentRegistry: agentSpawn.subAgentRegistry,
      systemPromptAssembler: agentSpawn.systemPromptAssembler,
      agentRegistry: agentSpawn.agentRegistry,
      agentRole: 'worker',
      enableCacheControl,
    });

    for await (const msg of generator) {
      if (subAbortController.signal.aborted) break;

      switch (msg.type) {
        case 'assistant': {
          assistantTurnCount++;
          const assistantMsg = msg.message as unknown as Message;
          transcript.push(assistantMsg);
          const blocks = Array.isArray(assistantMsg.content) ? assistantMsg.content : [];

          // New turn — clear live tool calls from previous turn so idle
          // detection (empty liveToolCalls = idle) works between turns.
          accumulatedLiveCalls.length = 0;

          // Count tools, excluding Listen (passive wait, not real work).
          const nonListenBlocks = blocks.filter(
            (b: ContentBlock) => b.type === 'tool_use' && (b as { name?: string }).name !== 'Listen',
          );
          toolCount += nonListenBlocks.length;

          // Push live tool calls to registry for real-time TUI display.
          if (nonListenBlocks.length > 0) {
            for (const block of nonListenBlocks) {
              const b = block as { name?: string; input?: Record<string, unknown> };
              const inputStr = b.input ? JSON.stringify(b.input) : '';
              accumulatedLiveCalls.push({ name: b.name ?? 'unknown', input: inputStr, state: 'executing' });
            }
          }

          // Update counters + live tool calls only — transcript is a shared
          // reference already registered above, no need to copy it.
          agentSpawn.subAgentRegistry.update(agentId, {
            liveToolCalls: [...accumulatedLiveCalls],
            turnCount: assistantTurnCount,
            messageCount: transcript.length,
            toolCount,
          });
          break;
        }
        case 'user':
          transcript.push(msg.message as unknown as Message);
          agentSpawn.subAgentRegistry.update(agentId, {
            messageCount: transcript.length,
          });
          break;
        case 'system':
          if (msg.subtype === 'progress') {
            const usage = subSessionManager.getActive().tokenUsage;
            agentSpawn.subAgentRegistry.update(agentId, {
              turnCount: assistantTurnCount,
              messageCount: transcript.length,
              toolCount,
              tokenUsage: {
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                cacheCreationInputTokens: usage.cacheCreationInputTokens,
                cacheReadInputTokens: usage.cacheReadInputTokens,
                totalTokens: usage.totalTokens,
              },
            });
          }
          break;
      }
      messageCount++;
    }

    const subSession = subSessionManager.getActive();
    const subTokenUsage = subSession ? {
      inputTokens: subSession.tokenUsage.inputTokens,
      outputTokens: subSession.tokenUsage.outputTokens,
      cacheCreationInputTokens: subSession.tokenUsage.cacheCreationInputTokens ?? 0,
      cacheReadInputTokens: subSession.tokenUsage.cacheReadInputTokens ?? 0,
      totalCost: subSession.totalCost,
    } : undefined;

    // Release sub-agent session messages to free memory promptly.
    if (subSession) subSession.messages = [];

    return {
      agentId, agentType, assistantTurnCount, toolCount,
      transcript, startTime, tokenUsage: subTokenUsage,
    };
  } catch (err) {
    const subSession = subSessionManager.getActive();
    const subTokenUsage = subSession ? {
      inputTokens: subSession.tokenUsage.inputTokens,
      outputTokens: subSession.tokenUsage.outputTokens,
      cacheCreationInputTokens: subSession.tokenUsage.cacheCreationInputTokens ?? 0,
      cacheReadInputTokens: subSession.tokenUsage.cacheReadInputTokens ?? 0,
      totalCost: subSession.totalCost,
    } : undefined;

    // Release sub-agent session messages to free memory promptly.
    if (subSession) subSession.messages = [];

    return {
      agentId, agentType, assistantTurnCount, toolCount,
      transcript, startTime,
      error: err instanceof Error ? err.message : String(err),
      tokenUsage: subTokenUsage,
    };
  }
}

// ---------------------------------------------------------------------------
// Worktree cleanup helper
// ---------------------------------------------------------------------------

export interface WorktreeCleanup {
  worktreePath: string;
  worktreeBranch?: string;
  worktreeGitRoot?: string;
  worktreeHeadCommit?: string;
  worktreeHookBased?: boolean;
}

export async function cleanupAgentWorktree(
  wt: WorktreeCleanup,
  hookManager?: AgentSpawnContext['hookManager'],
): Promise<string> {
  const { worktreePath, worktreeBranch, worktreeGitRoot, worktreeHeadCommit, worktreeHookBased } = wt;
  try {
    let changed = false;
    if (worktreeHeadCommit && !worktreeHookBased) {
      changed = await hasWorktreeChanges(worktreePath, worktreeHeadCommit);
    }
    if (changed) {
      return `\nWorktree preserved at: ${worktreePath}`;
    }
    await removeAgentWorktree(worktreePath, worktreeBranch, worktreeGitRoot, worktreeHookBased, hookManager);
    return '';
  } catch {
    return `\nWorktree left at: ${worktreePath} (cleanup failed)`;
  }
}
