import { join } from 'node:path';
import type { ToolExecutor, ToolResult } from '../../tools/types.js';
import type { Message, ContentBlock, AgentSpawnContext, ToolContext } from '../../core/types.js';
import type { SystemPrompt, SystemPromptAssembler } from '../../core/system-prompt.js';
import type { SubAgentRecord } from '../../core/subagent-registry.js';
import { ToolRegistry } from '../../core/tool-registry.js';
import { PermissionEngine } from '../../core/permission.js';
import { PermissionMode, RiskLevel } from '../../core/types.js';
import { SessionManager } from '../../core/session.js';
import { CheckpointManager } from '../../core/checkpoint.js';
import { filterToolsForAgent, filterToolsForResumedAgent, GLOBAL_DISALLOWED_FOR_SUBAGENTS } from '../tool-filtering.js';
import { query } from '../../core/query.js';
import teamMessagePlugin from '../../teams/tools/team-message/index.js';
import {
  runWithAgentContext,
  createSubagentContext,
  type SubagentContext,
} from '../agent-context.js';
import {
  isAgentMemoryEnabled,
  loadAgentMemoryPrompt,
  augmentToolsForMemory,
} from '../agent-memory.js';
import {
  createAgentWorktree,
  removeAgentWorktree,
  hasWorktreeChanges,
} from '../../utils/worktree.js';
import { writeAgentOutput } from './output-writer.js';
import { spawnTeammate } from './spawn-teammate.js';
import {
  agentDir,
  writeAgentMetadata,
  readAgentMetadata,
  getAgentTranscript,
  saveAgentTranscript,
} from '../agent-persistence.js';

const DEFAULT_MAX_TURNS = 200;
const DEFAULT_CONTEXT_BUDGET = 120_000;
const DEFAULT_MAX_CONCURRENCY = 8;

function shortId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function compressTranscript(messages: Message[]): string {
  const parts: string[] = [];
  for (const msg of messages.slice(-60)) {
    if (msg.role !== 'assistant') continue;
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    for (const block of blocks) {
      if (block.type === 'text') {
        const text = (block as { text?: string }).text ?? '';
        if (text) parts.push(text.slice(0, 8000));
      }
    }
  }
  const body = parts.join('\n\n');
  if (!body) return '(sub-agent produced no text output)';
  if (body.length <= 16384) return body;
  return body.slice(0, 16381) + '...';
}

interface ToolCallSummary {
  name: string;
  input: string;
  state: string;
}

function extractToolCalls(messages: Message[]): ToolCallSummary[] {
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
async function enrichAgentPrompt(
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

/**
 * Whether fork subagent mode is enabled.
 * Controlled by CODERIX_FORK_SUBAGENT env var or settings.
 */
function isForkSubagentEnabled(): boolean {
  if (process.env.CODERIX_FORK_SUBAGENT === '0') return false;
  // Fork is enabled by default (matches upstream behavior)
  return true;
}

// ---------------------------------------------------------------------------
// Fork helpers
// ---------------------------------------------------------------------------

const FORK_BOILERPLATE_TAG = 'fork-boilerplate';
const FORK_PLACEHOLDER_RESULT = 'Fork started -- processing in background';

/** Detect if the current conversation is already inside a fork child,
 *  preventing recursive forking (fork-of-fork). */
function isInForkChild(messages: Message[]): boolean {
  for (const msg of messages) {
    const content = typeof msg.content === 'string'
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content.map(b => (b as { text?: string }).text ?? '').join(' ')
        : '';
    if (content.includes(`<${FORK_BOILERPLATE_TAG}>`)) return true;
  }
  return false;
}

/** Build the fork boilerplate directive injected into every fork child.
 *  Contains non-negotiable rules and a structured output format. */
function buildForkChildMessage(prompt: string): string {
  return [
    `<${FORK_BOILERPLATE_TAG}>`,
    'You are a fork of the parent agent with full context and tools.',
    '',
    'Non-negotiable rules:',
    '1. Do NOT spawn sub-agents or teammates — you are the worker',
    '2. Do NOT have a conversation — just complete the task',
    '3. Use tools directly, do not ask for clarification',
    '4. Commit any code changes before reporting back',
    '5. Work independently — do not wait for the parent',
    '6. Be thorough — the parent is waiting for your complete result',
    '7. Search broadly first, then narrow down',
    '8. Report concrete findings, not vague summaries',
    '9. If you encounter errors, try alternative approaches before giving up',
    '',
    'Output format:',
    'Scope: <one sentence summarizing what was asked>',
    'Result: <key findings or deliverables>',
    'Key files: <relevant file paths examined or modified>',
    'Files changed: <list of modified files with commit hash if applicable>',
    'Issues: <any blockers, errors, or unresolved items>',
    `</${FORK_BOILERPLATE_TAG}>`,
    '',
    `Your directive: ${prompt}`,
  ].join('\n');
}

/** Build cache-identical fork messages so parallel forks share the prompt cache.
 *  Collects all tool_use blocks from the parent's assistant message and creates
 *  identical placeholder tool_result blocks, then appends the child directive. */
function buildForkedMessages(
  prompt: string,
  parentMessages: Message[],
): Message[] {
  // Find the last assistant message to extract tool_use blocks
  const lastAssistant = [...parentMessages].reverse().find(m => m.role === 'assistant');
  if (!lastAssistant || !Array.isArray(lastAssistant.content)) {
    // Fallback: parent's last messages + fork directive
    const recentMessages = parentMessages.slice(-50);
    return [
      ...recentMessages,
      { role: 'user' as const, content: buildForkChildMessage(prompt) },
    ];
  }

  const blocks = lastAssistant.content as ContentBlock[];
  const toolUseBlocks = blocks.filter(b => b.type === 'tool_use');

  if (toolUseBlocks.length === 0) {
    const recentMessages = parentMessages.slice(-50);
    return [
      ...recentMessages,
      { role: 'user' as const, content: buildForkChildMessage(prompt) },
    ];
  }

  // Build placeholder tool_results with identical text (cache-sharing key)
  const placeholderBlocks: ContentBlock[] = toolUseBlocks.map(tu => ({
    type: 'tool_result' as const,
    tool_use_id: (tu as { id?: string }).id ?? '',
    content: FORK_PLACEHOLDER_RESULT,
  }));

  // One user message with all placeholder results + fork directive
  const forkMessage: Message = {
    role: 'user',
    content: [
      ...placeholderBlocks,
      { type: 'text' as const, text: buildForkChildMessage(prompt) },
    ],
  };

  // Build cache-identical fork messages for prompt cache sharing.
  // Include full parent history so the fork has context, followed by the
  // fork prefix message with placeholder tool_results and directive.
  return [...parentMessages, forkMessage];
}

/** Worktree path-translation notice injected when fork uses worktree isolation. */
function buildWorktreeNotice(parentCwd: string, worktreeCwd: string): string {
  return [
    'Note: You are running in an isolated git worktree.',
    `Parent working directory: ${parentCwd}`,
    `Your working directory: ${worktreeCwd}`,
    'Use your worktree path for all file operations.',
    'When referencing files in your report, use paths relative to your working directory.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Core runner — shared by sync and async paths
// ---------------------------------------------------------------------------

interface RunAgentParams {
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

async function runAgentLoop(params: RunAgentParams): Promise<{
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

  const subSessionManager = new SessionManager();
  subSessionManager.create({
    title: `Sub-agent: ${agentType}`,
    cwd,
    model: effectiveModel,
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
          const newToolCount = blocks.filter((b: ContentBlock) => b.type === 'tool_use').length;
          toolCount += newToolCount;

          // Push live tool calls to registry for real-time TUI display
          if (newToolCount > 0) {
            for (const block of blocks) {
              if (block.type === 'tool_use') {
                const b = block as { name?: string; input?: Record<string, unknown> };
                const inputStr = b.input ? JSON.stringify(b.input) : '';
                accumulatedLiveCalls.push({ name: b.name ?? 'unknown', input: inputStr, state: 'executing' });
              }
            }
          }

          // Push transcript snapshot for real-time immersive sub-agent view
          agentSpawn.subAgentRegistry.update(agentId, {
            liveToolCalls: [...accumulatedLiveCalls],
            transcript: [...transcript],
            turnCount: assistantTurnCount,
            messageCount: transcript.length,
            toolCount,
          });
          break;
        }
        case 'user':
          transcript.push(msg.message as unknown as Message);
          agentSpawn.subAgentRegistry.update(agentId, {
            transcript: [...transcript],
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

interface WorktreeCleanup {
  worktreePath: string;
  worktreeBranch?: string;
  worktreeGitRoot?: string;
  worktreeHeadCommit?: string;
  worktreeHookBased?: boolean;
}

async function cleanupAgentWorktree(wt: WorktreeCleanup, hookManager?: import('../../core/types.js').AgentSpawnContext['hookManager']): Promise<string> {
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

// ---------------------------------------------------------------------------
// Standard subagent path — explicit agent_type
// ---------------------------------------------------------------------------

async function executeStandardSubagent(
  input: Record<string, unknown>,
  agentSpawn: AgentSpawnContext,
  options: { cwd?: string; sessionId?: string; agentId?: string },
): Promise<ToolResult> {
  const agentTypeInput = input.agent_type as string;
  const prompt = input.prompt as string;
  const description = input.description as string | undefined;
  const modelOverride = input.model as string | undefined;
  const backgroundOverride = input.background as boolean | undefined;
  const isolation = input.isolation as 'worktree' | undefined;

  const agentDef = agentSpawn.agentRegistry?.get(agentTypeInput);
  if (!agentDef) {
    const available = agentSpawn.agentRegistry?.list().map(a => a.agentType).join(', ') ?? 'none';
    return {
      content: `Unknown agent type: ${agentTypeInput}. Available: ${available}`,
      isError: true,
    };
  }

  const agentType = agentTypeInput;
  const agentId = options.agentId ?? `sub-${shortId()}`;
  const subAbortController = new AbortController();
  const isBackground = false;

  // Build filtered tool registry from the agent definition
  const parentDefs = agentSpawn.toolRegistry.getDefinitions();
  let effectiveTools = agentDef.tools;
  if (isAgentMemoryEnabled() && agentDef.memory) {
    effectiveTools = augmentToolsForMemory(effectiveTools ?? '*');
  }
  const agentDefForFilter = effectiveTools !== agentDef.tools
    ? { ...agentDef, tools: effectiveTools }
    : agentDef;
  const filteredDefs = filterToolsForAgent(parentDefs, agentDefForFilter);
  const subToolRegistry = new ToolRegistry();
  for (const def of filteredDefs) {
    const registration = agentSpawn.toolRegistry.get(def.name);
    if (registration) {
      subToolRegistry.register(def, registration.execute);
    }
  }

  // Team member: register SendMessage tool for inter-team communication
  const teamName = input.team_name as string | undefined;
  const memberName = input.member_name as string | undefined;
  if (teamName && memberName) {
    const teamMsgSchema = teamMessagePlugin.schema as unknown as { input_schema: Record<string, unknown>; description: string };
    subToolRegistry.register(
      {
        name: teamMessagePlugin.name,
        description: teamMsgSchema.description,
        input_schema: teamMsgSchema.input_schema,
        riskLevel: RiskLevel.SAFE,
      },
      async (toolInput: Record<string, unknown>, ctx: ToolContext) => {
        const result = await teamMessagePlugin.executor(
          { ...toolInput, from: memberName },
          {
            cwd: ctx.cwd ?? process.cwd(),
            allowMutation: true,
            maxOutput: 50_000,
            bashTimeout: 30_000,
            sessionId: ctx.sessionId,
          },
        );
        return {
          content: result.content,
          isError: result.isError,
          duration: result.duration,
          metadata: result.metadata,
        };
      },
    );
  }

  const effectiveModel = modelOverride ?? agentDef.model;

  // ── Worktree isolation ──────────────────────────────────────────────
  let worktreePath: string | undefined;
  let worktreeBranch: string | undefined;
  let worktreeGitRoot: string | undefined;
  let worktreeHeadCommit: string | undefined;
  let worktreeHookBased: boolean | undefined;
  const effectiveCwd = options.cwd ?? process.cwd();

  const effectiveIsolation = isolation ?? agentDef.isolation;
  if (effectiveIsolation === 'worktree') {
    try {
      const wt = await createAgentWorktree(`${agentType}-${agentId}`, agentSpawn.hookManager);
      worktreePath = wt.worktreePath;
      worktreeBranch = wt.worktreeBranch;
      worktreeGitRoot = wt.gitRoot;
      worktreeHeadCommit = wt.headCommit;
      worktreeHookBased = wt.hookBased;
    } catch (err) {
      return {
        content: `Failed to create worktree for ${agentType} agent: ${(err as Error).message}`,
        isError: true,
      };
    }
  }

  // Prepend initialPrompt if defined
  const userPrompt = agentDef.initialPrompt
    ? `${agentDef.initialPrompt}\n\n${prompt}`
    : prompt;

  const initialMessages: Message[] = [
    { role: 'user', content: userPrompt },
  ];

  // Enrich agent prompt with environment info
  let enrichedPrompt = agentSpawn.systemPromptAssembler
    ? await enrichAgentPrompt(agentDef.getSystemPrompt(), agentSpawn.systemPromptAssembler)
    : agentDef.getSystemPrompt();

  // Inject memory if enabled and agent declares a memory scope
  if (isAgentMemoryEnabled() && agentDef.memory) {
    const memoryPrompt = await loadAgentMemoryPrompt(
      agentType,
      agentDef.memory,
      worktreePath ?? process.cwd(),
    );
    if (memoryPrompt) {
      enrichedPrompt = memoryPrompt + '\n\n' + enrichedPrompt;
    }
  }

  agentSpawn.subAgentRegistry.register({
    id: agentId,
    name: `${agentType}-${agentId}`,
    agentType: agentType as 'explore' | 'plan' | 'general-purpose',
    status: 'running',
    prompt,
    description,
    createdAt: Date.now(),
    turnCount: 0,
    messageCount: 0,
    toolCount: 0,
    abortController: subAbortController,
    notified: false,
  });

  agentSpawn.sessionManager.trackSubAgent(agentId);

  if (isBackground) {
    // ── Async path: fire-and-forget ─────────────────────────────────
    const spawnTime = Date.now();
    const bgSessionId = options.sessionId;
    const bgContext: SubagentContext = createSubagentContext(
      agentId,
      agentType,
      agentDef.source === 'built-in',
    );

    runWithAgentContext(bgContext, () => {
      runAgentLoop({
        agentId, agentType, prompt, agentSpawn,
        systemPromptText: enrichedPrompt,
        effectiveModel, subToolRegistry, subAbortController,
        effectiveMaxTurns: agentDef.maxTurns ?? DEFAULT_MAX_TURNS,
        effectiveContextBudget: agentDef.contextBudget ?? DEFAULT_CONTEXT_BUDGET,
        initialMessages,
        cwd: worktreePath ?? effectiveCwd,
      }).then(async result => {
        let cleanupNote = '';
        if (worktreePath) {
          cleanupNote = await cleanupAgentWorktree({
            worktreePath, worktreeBranch, worktreeGitRoot, worktreeHeadCommit, worktreeHookBased,
          }, agentSpawn.hookManager);
        }

        const status = result.error ? 'error' : (subAbortController.signal.aborted ? 'stopped' : 'done');
        const compressed = compressTranscript(result.transcript);
        const elapsed = (Date.now() - result.startTime) / 1000;

        let outputPath: string | undefined;
        if (bgSessionId) {
          try {
            outputPath = await writeAgentOutput(bgSessionId, agentId, {
              status, agentType, prompt,
              turnCount: result.assistantTurnCount,
              toolCount: result.toolCount, elapsed,
              result: compressed, error: result.error,
              transcript: result.transcript,
            });
          } catch { /* Non-fatal */ }
        }

        agentSpawn.subAgentRegistry.update(agentId, {
          status, finishedAt: Date.now(),
          turnCount: result.assistantTurnCount,
          messageCount: result.transcript.length,
          toolCount: result.toolCount,
          result: compressed,
          transcript: result.transcript,
          error: result.error,
          outputPath,
          tokenUsage: result.tokenUsage,
        });

        // Persist to disk for cross-session resume
        writeAgentMetadata(agentId, {
          agentType, worktreePath, description: prompt, displayDescription: description,
          model: effectiveModel, createdAt: result.startTime, finishedAt: Date.now(),
        }).catch(() => {});
        saveAgentTranscript(agentId, result.transcript).catch(() => {});

        agentSpawn.subAgentRegistry.notifyAgentCompletion(agentId);
      }).catch(async err => {
        if (worktreePath) {
          await cleanupAgentWorktree({
            worktreePath, worktreeBranch, worktreeGitRoot, worktreeHeadCommit, worktreeHookBased,
          }, agentSpawn.hookManager).catch(() => {});
        }
        const errorMsg = err instanceof Error ? err.message : String(err);
        agentSpawn.subAgentRegistry.update(agentId, {
          status: 'error', finishedAt: Date.now(),
          error: errorMsg,
        });
        agentSpawn.subAgentRegistry.notifyAgentCompletion(agentId);
      });
    });

    return {
      content: `Background agent ${agentId} (${agentType}) running. Results will be delivered automatically when complete. Do not poll — just wait.${worktreePath ? ` (isolated in worktree: ${worktreePath})` : ''}`,
      isError: false,
      duration: Date.now() - spawnTime,
      metadata: { agentId, agentType, background: true, worktreePath },
    };
  }

  // ── Sync path ──────────────────────────────────────────────────
  const subContext: SubagentContext = createSubagentContext(
    agentId, agentType, agentDef.source === 'built-in',
  );

  const result = await runWithAgentContext(subContext, () =>
    runAgentLoop({
      agentId, agentType, prompt, agentSpawn,
      systemPromptText: enrichedPrompt,
      effectiveModel, subToolRegistry, subAbortController,
      effectiveMaxTurns: agentDef.maxTurns ?? DEFAULT_MAX_TURNS,
      effectiveContextBudget: agentDef.contextBudget ?? DEFAULT_CONTEXT_BUDGET,
      initialMessages,
      cwd: worktreePath ?? effectiveCwd,
    }),
  );

  let cleanupNote = '';
  if (worktreePath) {
    cleanupNote = await cleanupAgentWorktree({
      worktreePath, worktreeBranch, worktreeGitRoot, worktreeHeadCommit, worktreeHookBased,
    }, agentSpawn.hookManager);
  }

  const status = result.error ? 'error' : (subAbortController.signal.aborted ? 'stopped' : 'done');
  const compressed = compressTranscript(result.transcript);

  agentSpawn.subAgentRegistry.update(agentId, {
    status, finishedAt: Date.now(),
    turnCount: result.assistantTurnCount,
    messageCount: result.transcript.length,
    toolCount: result.toolCount,
    result: compressed,
    transcript: result.transcript,
    error: result.error,
  });

  // Persist to disk for cross-session resume
  writeAgentMetadata(agentId, {
    agentType, worktreePath, description: prompt, displayDescription: description,
    model: effectiveModel, createdAt: result.startTime, finishedAt: Date.now(),
  }).catch(() => {});
  saveAgentTranscript(agentId, result.transcript).catch(() => {});

  if (result.error) {
    return {
      content: `Sub-agent ${agentId} (${agentType}) error after ${result.assistantTurnCount} turns: ${result.error}${cleanupNote}`,
      isError: true,
      duration: Date.now() - result.startTime,
      metadata: { agentId, agentType, error: result.error, worktreePath },
    };
  }

  const transcriptPath = join(agentDir(agentId), 'transcript.json');

  return {
    content: `Sub-agent ${agentId} (${agentType}) completed. ${result.assistantTurnCount} LLM turns, ${result.toolCount} tools used.\n\n${compressed}${cleanupNote}\n\nFull transcript: ${transcriptPath}`,
    isError: false,
    duration: Date.now() - result.startTime,
    metadata: {
      agentId, agentType,
      turnCount: result.assistantTurnCount,
      messageCount: result.transcript.length,
      toolCount: result.toolCount,
      duration: Date.now() - result.startTime,
      worktreePath,
      transcriptPath,
      toolCalls: extractToolCalls(result.transcript),
      tokenUsage: result.tokenUsage,
    },
  };
}

// ---------------------------------------------------------------------------
// Fork execution — inherit parent context
// ---------------------------------------------------------------------------

async function executeFork(
  prompt: string,
  description: string | undefined,
  modelOverride: string | undefined,
  isolation: 'worktree' | undefined,
  agentSpawn: AgentSpawnContext,
  bgSessionId?: string,
): Promise<ToolResult> {
  const agentType = 'fork';
  const agentId = `fork-${shortId()}`;
  const subAbortController = new AbortController();
  // Fork agents always run in foreground so the user can see real-time progress
  const isBackground = false;

  // ── Recursion guard ──────────────────────────────────────────────────
  const parentSession = agentSpawn.sessionManager.getActive();
  const parentMessages: Message[] = parentSession?.messages ?? [];
  if (isInForkChild(parentMessages)) {
    return {
      content: 'Cannot fork from a fork child. Fork depth is limited to 1. Use a standard sub-agent (specify agent_type) or complete the current fork task first.',
      isError: true,
    };
  }

  // ── Worktree isolation ──────────────────────────────────────────────
  let worktreePath: string | undefined;
  let worktreeBranch: string | undefined;
  let worktreeGitRoot: string | undefined;
  let worktreeHeadCommit: string | undefined;
  let worktreeHookBased: boolean | undefined;

  if (isolation === 'worktree') {
    try {
      const wt = await createAgentWorktree(`agent-${agentType}-${agentId}`, agentSpawn.hookManager);
      worktreePath = wt.worktreePath;
      worktreeBranch = wt.worktreeBranch;
      worktreeGitRoot = wt.gitRoot;
      worktreeHeadCommit = wt.headCommit;
      worktreeHookBased = wt.hookBased;
    } catch (err) {
      return {
        content: `Failed to create worktree for fork agent: ${(err as Error).message}`,
        isError: true,
      };
    }
  }

  // Inherit parent tools exactly — no filtering for fork. Byte-identical
  // tool definitions preserve the API request prefix for prompt cache hits.
  // Recursion is prevented by the isInForkChild() guard above.
  const parentDefs = agentSpawn.toolRegistry.getDefinitions();
  const subToolRegistry = new ToolRegistry();
  for (const def of parentDefs) {
    const registration = agentSpawn.toolRegistry.get(def.name);
    if (registration) {
      subToolRegistry.register(def, registration.execute);
    }
  }

  // Inherit parent's system prompt — prefer the already-rendered bytes
  // to share the prompt cache with the parent. Only re-assemble as fallback.
  let systemPromptText: string;
  if (agentSpawn.renderedSystemPrompt) {
    systemPromptText = agentSpawn.renderedSystemPrompt.prompt;
  } else {
    try {
      const assembler = agentSpawn.systemPromptAssembler;
      const parentSystem = await assembler.assemble({
        cwd: process.cwd(),
        permissionMode: PermissionMode.AUTO,
        agentRole: 'default',
      });
      systemPromptText = parentSystem.prompt;
    } catch {
      systemPromptText = 'You are a forked sub-agent with full context of the parent agent. Complete the assigned task efficiently.';
    }
  }

  const effectiveModel = modelOverride;
  const effectiveMaxTurns = 200;  // Fork agents get generous turn budget
  const effectiveContextBudget = DEFAULT_CONTEXT_BUDGET;
  const cwd = worktreePath ?? process.cwd();

  // Build cache-identical fork messages for prompt cache sharing
  const initialMessages: Message[] = buildForkedMessages(prompt, parentMessages);

  // Inject worktree path-translation notice when isolated
  if (worktreePath) {
    initialMessages.push({
      role: 'user',
      content: buildWorktreeNotice(process.cwd(), worktreePath),
    });
  }

  agentSpawn.subAgentRegistry.register({
    id: agentId,
    name: agentId,
    agentType: 'general-purpose',
    status: 'running',
    prompt,
    description,
    createdAt: Date.now(),
    turnCount: 0,
    messageCount: 0,
    toolCount: 0,
    abortController: subAbortController,
    notified: false,
  });

  agentSpawn.sessionManager.trackSubAgent(agentId);

  if (isBackground) {
    const spawnTime = Date.now();
    const forkBgSessionId = bgSessionId;
    const forkBgContext: SubagentContext = createSubagentContext(agentId, 'fork', true);

    runWithAgentContext(forkBgContext, () => {
      runAgentLoop({
        agentId, agentType, prompt, agentSpawn,
        systemPromptText, effectiveModel, subToolRegistry, subAbortController,
        effectiveMaxTurns, effectiveContextBudget, initialMessages,
        cwd,
        enableCacheControl: true,
      }).then(async result => {
        let cleanupNote = '';
        if (worktreePath) {
          cleanupNote = await cleanupAgentWorktree({
            worktreePath, worktreeBranch, worktreeGitRoot, worktreeHeadCommit, worktreeHookBased,
          }, agentSpawn.hookManager);
        }
        const status = result.error ? 'error' : (subAbortController.signal.aborted ? 'stopped' : 'done');
        const compressed = compressTranscript(result.transcript);
        const elapsed = (Date.now() - result.startTime) / 1000;

        let outputPath: string | undefined;
        if (forkBgSessionId) {
          try {
            outputPath = await writeAgentOutput(forkBgSessionId, agentId, {
              status, agentType: 'fork', prompt,
              turnCount: result.assistantTurnCount,
              toolCount: result.toolCount, elapsed,
              result: compressed, error: result.error,
              transcript: result.transcript,
            });
          } catch { /* Non-fatal */ }
        }

        agentSpawn.subAgentRegistry.update(agentId, {
          status, finishedAt: Date.now(),
          turnCount: result.assistantTurnCount,
          messageCount: result.transcript.length,
          toolCount: result.toolCount,
          result: compressed,
          transcript: result.transcript,
          error: result.error,
          outputPath,
          tokenUsage: result.tokenUsage,
        });

        // Persist to disk for cross-session resume
        writeAgentMetadata(agentId, {
          agentType: 'fork', worktreePath, description: prompt, displayDescription: description,
          model: effectiveModel, createdAt: result.startTime, finishedAt: Date.now(),
        }).catch(() => {});
        saveAgentTranscript(agentId, result.transcript).catch(() => {});

        agentSpawn.subAgentRegistry.notifyAgentCompletion(agentId);
      }).catch(async err => {
        if (worktreePath) {
          await cleanupAgentWorktree({
            worktreePath, worktreeBranch, worktreeGitRoot, worktreeHeadCommit, worktreeHookBased,
          }, agentSpawn.hookManager).catch(() => {});
        }
        agentSpawn.subAgentRegistry.update(agentId, {
          status: 'error', finishedAt: Date.now(),
          error: err instanceof Error ? err.message : String(err),
        });
        agentSpawn.subAgentRegistry.notifyAgentCompletion(agentId);
      });
    });

    return {
      content: `Fork agent ${agentId} spawned in background. Use TaskGet to check progress.${worktreePath ? ` (isolated in worktree: ${worktreePath})` : ''}`,
      isError: false,
      duration: Date.now() - spawnTime,
      metadata: { agentId, agentType: 'fork', background: true, worktreePath },
    };
  }

  // Sync fork
  const forkContext: SubagentContext = createSubagentContext(agentId, 'fork', true);

  const result = await runWithAgentContext(forkContext, () =>
    runAgentLoop({
      agentId, agentType, prompt, agentSpawn,
      systemPromptText, effectiveModel, subToolRegistry, subAbortController,
      effectiveMaxTurns, effectiveContextBudget, initialMessages,
      cwd,
      enableCacheControl: true,
    }),
  );

  let cleanupNote = '';
  if (worktreePath) {
    cleanupNote = await cleanupAgentWorktree({
      worktreePath, worktreeBranch, worktreeGitRoot, worktreeHeadCommit, worktreeHookBased,
    }, agentSpawn.hookManager);
  }

  const status = result.error ? 'error' : (subAbortController.signal.aborted ? 'stopped' : 'done');
  const compressed = compressTranscript(result.transcript);

  agentSpawn.subAgentRegistry.update(agentId, {
    status, finishedAt: Date.now(),
    turnCount: result.assistantTurnCount,
    messageCount: result.transcript.length,
    toolCount: result.toolCount,
    result: compressed,
    transcript: result.transcript,
    error: result.error,
  });

  // Persist to disk for cross-session resume
  writeAgentMetadata(agentId, {
    agentType: 'fork', worktreePath, description: prompt, displayDescription: description,
    model: effectiveModel, createdAt: result.startTime, finishedAt: Date.now(),
  }).catch(() => {});
  saveAgentTranscript(agentId, result.transcript).catch(() => {});

  if (result.error) {
    return {
      content: `Fork agent ${agentId} error after ${result.assistantTurnCount} turns: ${result.error}${cleanupNote}`,
      isError: true,
      duration: Date.now() - result.startTime,
      metadata: { agentId, agentType: 'fork', error: result.error, worktreePath },
    };
  }

  const forkTranscriptPath = join(agentDir(agentId), 'transcript.json');

  return {
    content: `Fork agent ${agentId} completed. ${result.assistantTurnCount} LLM turns, ${result.toolCount} tools used.\n\n${compressed}${cleanupNote}\n\nFull transcript: ${forkTranscriptPath}`,
    isError: false,
    duration: Date.now() - result.startTime,
    metadata: {
      agentId, agentType: 'fork',
      turnCount: result.assistantTurnCount,
      messageCount: result.transcript.length,
      toolCount: result.toolCount,
      duration: Date.now() - result.startTime,
      worktreePath,
      transcriptPath: forkTranscriptPath,
      toolCalls: extractToolCalls(result.transcript),
      tokenUsage: result.tokenUsage,
    },
  };
}

// ---------------------------------------------------------------------------
// Agent resume — continue a stopped/completed agent
// ---------------------------------------------------------------------------

async function executeResume(
  agentId: string,
  prompt: string,
  agentSpawn: AgentSpawnContext,
  options: { cwd?: string; sessionId?: string },
): Promise<ToolResult> {
  // ── Look up agent in registry ────────────────────────────────────────
  let agent = agentSpawn.subAgentRegistry.get(agentId);

  // ── Fallback: try loading from disk (cross-session resume) ──────────
  if (!agent) {
    const meta = await readAgentMetadata(agentId);
    const transcript = await getAgentTranscript(agentId);

    if (!meta || !transcript) {
      return {
        content: [
          `Agent '${agentId}' not found in registry or on disk.`,
          'The agent may have been cleaned up or never existed.',
          'Use TaskGet to list available agents.',
        ].join('\n'),
        isError: true,
      };
    }

    // Validate worktree still exists (for worktree agents)
    let worktreePath: string | undefined;
    if (meta.worktreePath) {
      try {
        const { stat } = await import('node:fs/promises');
        await stat(meta.worktreePath);
        worktreePath = meta.worktreePath;
      } catch {
        // Worktree was removed externally — run in current cwd
      }
    }

    // Re-register in memory
    const abortController = new AbortController();
    agentSpawn.subAgentRegistry.register({
      id: agentId,
      name: `${meta.agentType}-${agentId}`,
      agentType: (meta.agentType as SubAgentRecord['agentType']) || 'general-purpose',
      status: 'stopped',
      prompt: meta.description ?? '',
      description: meta.displayDescription,
      createdAt: meta.createdAt,
      turnCount: transcript.filter(m => m.role === 'assistant').length,
      messageCount: transcript.length,
      toolCount: 0,
      abortController,
      notified: true,
      transcript,
    });

    agent = agentSpawn.subAgentRegistry.get(agentId);
    if (!agent) {
      return { content: `Failed to re-register agent '${agentId}' from disk.`, isError: true };
    }
  }

  // ── Validate state ───────────────────────────────────────────────────
  if (agent.status === 'running') {
    return {
      content: `Cannot resume running agent '${agentId}'. Wait for it to complete, or use TaskStop to cancel it first.`,
      isError: true,
    };
  }

  const transcript = agent.transcript ?? [];
  const agentType = agent.agentType;

  // ── Look up agent definition ─────────────────────────────────────────
  const agentDef = agentSpawn.agentRegistry?.get(agentType);
  const effectiveMaxTurns = agentDef?.maxTurns ?? 200;

  // ── Build resumed messages ───────────────────────────────────────────
  const resumedMessages: Message[] = [
    ...transcript,
    { role: 'user', content: prompt },
  ];

  // ── Build filtered tool registry ─────────────────────────────────────
  const parentDefs = agentSpawn.toolRegistry.getDefinitions();
  const filteredDefs = agentDef
    ? filterToolsForResumedAgent(parentDefs, agentDef)
    : parentDefs.filter(t => !GLOBAL_DISALLOWED_FOR_SUBAGENTS.has(t.name));
  const subToolRegistry = new ToolRegistry();
  for (const def of filteredDefs) {
    const registration = agentSpawn.toolRegistry.get(def.name);
    if (registration) {
      subToolRegistry.register(def, registration.execute);
    }
  }

  // ── Build system prompt (with env enrichment) ────────────────────────
  let systemPromptText: string;
  if (agentDef) {
    systemPromptText = agentSpawn.systemPromptAssembler
      ? await enrichAgentPrompt(agentDef.getSystemPrompt(), agentSpawn.systemPromptAssembler)
      : agentDef.getSystemPrompt();
  } else {
    systemPromptText = [
      'You are a sub-agent worker spawned by Coderix to complete a specific task.',
      'Complete the task efficiently using the tools available to you.',
      'You CANNOT spawn additional sub-agents.',
      'Do not ask the user questions — you operate autonomously.',
    ].join('\n');
  }

  // Inject memory if enabled
  if (agentDef && isAgentMemoryEnabled() && agentDef.memory) {
    const memoryPrompt = await loadAgentMemoryPrompt(
      agentType,
      agentDef.memory,
      options.cwd ?? process.cwd(),
    );
    if (memoryPrompt) {
      systemPromptText = memoryPrompt + '\n\n' + systemPromptText;
    }
  }

  const cwd = options.cwd ?? process.cwd();
  const subAbortController = new AbortController();

  // ── Update registry status ──────────────────────────────────────────
  agentSpawn.subAgentRegistry.update(agentId, {
    status: 'running',
    abortController: subAbortController,
  });

  // ── Run agent loop ──────────────────────────────────────────────────
  const result = await runAgentLoop({
    agentId,
    agentType,
    prompt,
    agentSpawn,
    systemPromptText,
    effectiveModel: undefined,  // Use default model
    effectiveMaxTurns,
    effectiveContextBudget: agentDef?.contextBudget ?? DEFAULT_CONTEXT_BUDGET,
    initialMessages: resumedMessages,
    subToolRegistry,
    subAbortController,
    cwd,
  });

  const status = result.error ? 'error' : (subAbortController.signal.aborted ? 'stopped' : 'done');
  const compressed = compressTranscript(result.transcript);
  const cumulativeTranscript = [...transcript, ...result.transcript];

  // ── Update registry ─────────────────────────────────────────────────
  agentSpawn.subAgentRegistry.update(agentId, {
    status,
    finishedAt: Date.now(),
    turnCount: agent.turnCount + result.assistantTurnCount,
    messageCount: cumulativeTranscript.length,
    toolCount: agent.toolCount + result.toolCount,
    result: compressed,
    transcript: cumulativeTranscript,
    error: result.error,
  });

  // Persist updated transcript to disk
  saveAgentTranscript(agentId, cumulativeTranscript).catch(() => {});
  writeAgentMetadata(agentId, {
    agentType, worktreePath: undefined, description: agent.prompt, displayDescription: agent.description,
    createdAt: agent.createdAt, finishedAt: Date.now(),
  }).catch(() => {});

  if (result.error) {
    return {
      content: `Sub-agent ${agentId} (${agentType}) resume error after ${result.assistantTurnCount} turns: ${result.error}`,
      isError: true,
      duration: Date.now() - result.startTime,
      metadata: { agentId, agentType, resumed: true, error: result.error },
    };
  }

  const resumeTranscriptPath = join(agentDir(agentId), 'transcript.json');

  return {
    content: `Sub-agent ${agentId} (${agentType}) resumed and completed. +${result.assistantTurnCount} LLM turns, +${result.toolCount} tools.\n\n${compressed}\n\nFull transcript: ${resumeTranscriptPath}`,
    isError: false,
    duration: Date.now() - result.startTime,
    metadata: {
      agentId, agentType, resumed: true,
      turnCount: result.assistantTurnCount, toolCount: result.toolCount,
      totalTurns: agent.turnCount + result.assistantTurnCount,
      duration: Date.now() - result.startTime,
      transcriptPath: resumeTranscriptPath,
      toolCalls: extractToolCalls(result.transcript),
      tokenUsage: result.tokenUsage,
    },
  };
}

// ---------------------------------------------------------------------------
// Execute — 4-path routing
// ---------------------------------------------------------------------------

export const execute: ToolExecutor = async (input, options): Promise<ToolResult> => {
  const agentSpawn = options.agentSpawn;
  if (!agentSpawn) {
    return {
      content: 'Agent requires agentSpawn context.',
      isError: true,
    };
  }

  const agentTypeInput = input.agent_type as string | undefined;
  const prompt = input.prompt as string;
  const description = input.description as string | undefined;
  const modelOverride = input.model as string | undefined;
  const backgroundOverride = input.background as boolean | undefined;
  const isolation = input.isolation as 'worktree' | undefined;
  const teamName = input.team_name as string | undefined;
  const agentName = input.name as string | undefined;
  const agentIdInput = input.agent_id as string | undefined;
  const resumeFlag = input.resume as boolean | undefined;

  // ── Path 1: Swarm teammate — team_name + name = process-level teammate ─
  if (teamName && agentName) {
    return spawnTeammate({
      teamName,
      agentName,
      prompt,
      model: modelOverride,
      background: backgroundOverride ?? true,
      isolation,
      agentSpawn,
      agentType: agentTypeInput || 'general-purpose',
      agentDef: agentTypeInput
        ? agentSpawn.agentRegistry?.get(agentTypeInput) ?? null
        : null,
      cwd: options.cwd ?? process.cwd(),
      sessionId: options.sessionId,
    });
  }

  // ── Path 2.5: Resume — agent_id + resume flag ───────────────────
  if (agentIdInput && resumeFlag) {
    return executeResume(agentIdInput, prompt, agentSpawn, {
      cwd: options.cwd,
      sessionId: options.sessionId,
    });
  }

  // ── Path 2: Fork mode — no agent_type → inherit parent context ────
  if (!agentTypeInput && isForkSubagentEnabled()) {
    return executeFork(prompt, description, modelOverride, isolation, agentSpawn, options.sessionId);
  }

  // ── Path 3: Standard subagent — explicit agent_type ───────────────
  return executeStandardSubagent(input, agentSpawn, {
    cwd: options.cwd,
    sessionId: options.sessionId,
    agentId: options.agentId,
  });
};
