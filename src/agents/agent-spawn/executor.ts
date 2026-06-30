import type { ToolExecutor, ToolResult } from '../../tools/types.js';
import type { Message, ContentBlock, AgentSpawnContext, ToolContext } from '../../core/types.js';
import type { SystemPrompt, SystemPromptAssembler } from '../../core/system-prompt.js';
import { ToolRegistry } from '../../core/tool-registry.js';
import { PermissionEngine } from '../../core/permission.js';
import { PermissionMode, RiskLevel } from '../../core/types.js';
import { SessionManager } from '../../core/session.js';
import { CheckpointManager } from '../../core/checkpoint.js';
import { filterToolsForAgent, GLOBAL_DISALLOWED_FOR_SUBAGENTS } from '../tool-filtering.js';
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

const DEFAULT_MAX_TURNS = 20;
const DEFAULT_CONTEXT_BUDGET = 120_000;
const DEFAULT_MAX_CONCURRENCY = 8;

function shortId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function compressTranscript(messages: Message[]): string {
  const parts: string[] = [];
  for (const msg of messages.slice(-20)) {
    if (msg.role !== 'assistant') continue;
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    for (const block of blocks) {
      if (block.type === 'text') {
        const text = (block as { text?: string }).text ?? '';
        if (text) parts.push(text.slice(0, 800));
      }
    }
  }
  const body = parts.join('\n\n');
  if (!body) return '(sub-agent produced no text output)';
  if (body.length <= 2000) return body;
  return body.slice(0, 1997) + '...';
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
}

async function runAgentLoop(params: RunAgentParams): Promise<{
  agentId: string;
  agentType: string;
  assistantTurnCount: number;
  toolCount: number;
  transcript: Message[];
  startTime: number;
  error?: string;
}> {
  const {
    agentId, agentType, prompt, agentSpawn,
    systemPromptText, effectiveModel, effectiveMaxTurns, effectiveContextBudget,
    initialMessages, subToolRegistry, subAbortController, cwd,
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
  const transcript: Message[] = [];

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
      compactThreshold: 0.7,
      maxToolConcurrency: DEFAULT_MAX_CONCURRENCY,
      callModel: agentSpawn.callModel,
      hookManager: agentSpawn.hookManager,
    });

    for await (const msg of generator) {
      if (subAbortController.signal.aborted) break;

      switch (msg.type) {
        case 'assistant': {
          assistantTurnCount++;
          const assistantMsg = msg.message as unknown as Message;
          transcript.push(assistantMsg);
          const blocks = Array.isArray(assistantMsg.content) ? assistantMsg.content : [];
          toolCount += blocks.filter((b: ContentBlock) => b.type === 'tool_use').length;
          break;
        }
        case 'user':
          transcript.push(msg.message as unknown as Message);
          break;
        case 'system':
          if (msg.subtype === 'progress') {
            agentSpawn.subAgentRegistry.update(agentId, {
              turnCount: assistantTurnCount,
              messageCount: transcript.length,
              toolCount,
            });
          }
          break;
      }
      messageCount++;
    }

    return {
      agentId, agentType, assistantTurnCount, toolCount,
      transcript, startTime,
    };
  } catch (err) {
    return {
      agentId, agentType, assistantTurnCount, toolCount,
      transcript, startTime,
      error: err instanceof Error ? err.message : String(err),
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
// Execute
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
  const modelOverride = input.model as string | undefined;
  const backgroundOverride = input.background as boolean | undefined;
  const isolation = input.isolation as 'worktree' | undefined;

  // ── Fork mode: no agent_type → inherit parent context ───────────────
  if (!agentTypeInput) {
    return executeFork(prompt, modelOverride, backgroundOverride, isolation, agentSpawn, options.sessionId);
  }

  // ── Explicit agent_type path ────────────────────────────────────────
  const agentDef = agentSpawn.agentRegistry?.get(agentTypeInput);
  if (!agentDef) {
    const available = agentSpawn.agentRegistry?.list().map(a => a.agentType).join(', ') ?? 'none';
    return {
      content: `Unknown agent type: ${agentTypeInput}. Available: ${available}`,
      isError: true,
    };
  }

  const agentType = agentTypeInput;
  const agentId = `sub-${shortId()}`;
  const subAbortController = new AbortController();
  const isBackground = backgroundOverride ?? agentDef.background ?? false;

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

  // Team member: register team-message tool for inter-team communication
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
    createdAt: Date.now(),
    turnCount: 0,
    messageCount: 0,
    toolCount: 0,
    abortController: subAbortController,
  });

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
        // Worktree cleanup
        let cleanupNote = '';
        if (worktreePath) {
          cleanupNote = await cleanupAgentWorktree({
            worktreePath, worktreeBranch, worktreeGitRoot, worktreeHeadCommit, worktreeHookBased,
          }, agentSpawn.hookManager);
        }

        const status = result.error ? 'error' : (subAbortController.signal.aborted ? 'stopped' : 'done');
        const compressed = compressTranscript(result.transcript);
        const elapsed = (Date.now() - result.startTime) / 1000;

        // Write full result to disk
        let outputPath: string | undefined;
        if (bgSessionId) {
          try {
            outputPath = await writeAgentOutput(bgSessionId, agentId, {
              status,
              agentType,
              prompt,
              turnCount: result.assistantTurnCount,
              toolCount: result.toolCount,
              elapsed,
              result: compressed,
              error: result.error,
              transcript: result.transcript,
            });
          } catch {
            // Non-fatal: notification still works without disk output
          }
        }

        agentSpawn.subAgentRegistry.update(agentId, {
          status,
          finishedAt: Date.now(),
          turnCount: result.assistantTurnCount,
          messageCount: result.transcript.length,
          toolCount: result.toolCount,
          result: compressed,
          transcript: result.transcript,
          error: result.error,
          outputPath,
        });

        agentSpawn.subAgentRegistry.notifyAgentCompletion(agentId);
      }).catch(async err => {
        // Attempt worktree cleanup even on crash
        if (worktreePath) {
          await cleanupAgentWorktree({
            worktreePath, worktreeBranch, worktreeGitRoot, worktreeHeadCommit, worktreeHookBased,
          }, agentSpawn.hookManager).catch(() => {});
        }
        const errorMsg = err instanceof Error ? err.message : String(err);
        agentSpawn.subAgentRegistry.update(agentId, {
          status: 'error',
          finishedAt: Date.now(),
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

  // ── Sync path (existing behavior) ──────────────────────────────────
  const subContext: SubagentContext = createSubagentContext(
    agentId,
    agentType,
    agentDef.source === 'built-in',
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

  // Worktree cleanup
  let cleanupNote = '';
  if (worktreePath) {
    cleanupNote = await cleanupAgentWorktree({
      worktreePath, worktreeBranch, worktreeGitRoot, worktreeHeadCommit, worktreeHookBased,
    }, agentSpawn.hookManager);
  }

  const status = result.error ? 'error' : (subAbortController.signal.aborted ? 'stopped' : 'done');
  const compressed = compressTranscript(result.transcript);

  agentSpawn.subAgentRegistry.update(agentId, {
    status,
    finishedAt: Date.now(),
    turnCount: result.assistantTurnCount,
    messageCount: result.transcript.length,
    toolCount: result.toolCount,
    result: compressed,
    transcript: result.transcript,
    error: result.error,
  });

  if (result.error) {
    return {
      content: `Sub-agent ${agentId} (${agentType}) error after ${result.assistantTurnCount} turns: ${result.error}${cleanupNote}`,
      isError: true,
      duration: Date.now() - result.startTime,
      metadata: { agentId, agentType, error: result.error, worktreePath },
    };
  }

  return {
    content: `Sub-agent ${agentId} (${agentType}) completed. ${result.assistantTurnCount} LLM turns, ${result.toolCount} tools used.\n\n${compressed}${cleanupNote}`,
    isError: false,
    duration: Date.now() - result.startTime,
    metadata: {
      agentId,
      agentType,
      turnCount: result.assistantTurnCount,
      messageCount: result.transcript.length,
      toolCount: result.toolCount,
      duration: Date.now() - result.startTime,
      worktreePath,
    },
  };
};

// ---------------------------------------------------------------------------
// Fork execution — inherit parent context
// ---------------------------------------------------------------------------

async function executeFork(
  prompt: string,
  modelOverride: string | undefined,
  backgroundOverride: boolean | undefined,
  isolation: 'worktree' | undefined,
  agentSpawn: AgentSpawnContext,
  bgSessionId?: string,
): Promise<ToolResult> {
  const agentType = 'fork';
  const agentId = `fork-${shortId()}`;
  const subAbortController = new AbortController();
  const isBackground = backgroundOverride ?? false;

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

  // Inherit parent tools (minus globally disallowed)
  const parentDefs = agentSpawn.toolRegistry.getDefinitions();
  const filteredDefs = parentDefs.filter(t => !GLOBAL_DISALLOWED_FOR_SUBAGENTS.has(t.name));
  const subToolRegistry = new ToolRegistry();
  for (const def of filteredDefs) {
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
  const effectiveMaxTurns = DEFAULT_MAX_TURNS;
  const effectiveContextBudget = DEFAULT_CONTEXT_BUDGET;
  const cwd = worktreePath ?? process.cwd();

  // Inherit parent's full conversation context for cache-identical prefixes
  const parentSession = agentSpawn.sessionManager.getActive();
  const parentMessages = parentSession?.messages ?? [];
  // Take up to 50 recent messages for reasonable context inheritance
  const recentMessages = parentMessages.slice(-50);

  const userPrompt = `[Forked from parent agent]\n\n${prompt}`;
  const initialMessages: Message[] = [
    ...recentMessages,
    { role: 'user', content: userPrompt },
  ];

  agentSpawn.subAgentRegistry.register({
    id: agentId,
    name: `fork-${agentId}`,
    agentType: 'general-purpose',
    status: 'running',
    prompt,
    createdAt: Date.now(),
    turnCount: 0,
    messageCount: 0,
    toolCount: 0,
    abortController: subAbortController,
  });

  if (isBackground) {
    const spawnTime = Date.now();
    const forkBgSessionId = bgSessionId;
    const forkBgContext: SubagentContext = createSubagentContext(
      agentId,
      'fork',
      true,
    );

    runWithAgentContext(forkBgContext, () => {
      runAgentLoop({
        agentId, agentType, prompt, agentSpawn,
        systemPromptText, effectiveModel, subToolRegistry, subAbortController,
        effectiveMaxTurns, effectiveContextBudget, initialMessages,
        cwd,
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

        // Write full result to disk
        let outputPath: string | undefined;
        if (forkBgSessionId) {
          try {
            outputPath = await writeAgentOutput(forkBgSessionId, agentId, {
              status,
              agentType: 'fork',
              prompt,
              turnCount: result.assistantTurnCount,
              toolCount: result.toolCount,
              elapsed,
              result: compressed,
              error: result.error,
              transcript: result.transcript,
            });
          } catch {
            // Non-fatal
          }
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
        });

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
  const forkContext: SubagentContext = createSubagentContext(
    agentId,
    'fork',
    true,
  );

  const result = await runWithAgentContext(forkContext, () =>
    runAgentLoop({
      agentId, agentType, prompt, agentSpawn,
      systemPromptText, effectiveModel, subToolRegistry, subAbortController,
      effectiveMaxTurns, effectiveContextBudget, initialMessages,
      cwd,
    }),
  );

  // Worktree cleanup
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

  if (result.error) {
    return {
      content: `Fork agent ${agentId} error after ${result.assistantTurnCount} turns: ${result.error}${cleanupNote}`,
      isError: true,
      duration: Date.now() - result.startTime,
      metadata: { agentId, agentType: 'fork', error: result.error, worktreePath },
    };
  }

  return {
    content: `Fork agent ${agentId} completed. ${result.assistantTurnCount} LLM turns, ${result.toolCount} tools used.\n\n${compressed}${cleanupNote}`,
    isError: false,
    duration: Date.now() - result.startTime,
    metadata: {
      agentId, agentType: 'fork',
      turnCount: result.assistantTurnCount,
      messageCount: result.transcript.length,
      toolCount: result.toolCount,
      duration: Date.now() - result.startTime,
      worktreePath,
    },
  };
}
