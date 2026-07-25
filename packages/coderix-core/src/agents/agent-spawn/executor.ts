import type { ToolExecutor, ToolResult } from '../../tools/types.js';
import type { Message, ContentBlock, AgentSpawnContext } from '../../core/types.js';
import type { SystemPromptAssembler } from '../../core/system-prompt.js';
import type { SubAgentRecord } from '../../core/subagent-registry.js';
import { ToolRegistry } from '../../core/tool-registry.js';
import { PermissionMode } from '../../core/types.js';
import { filterToolsForAgent, filterToolsForResumedAgent, GLOBAL_DISALLOWED_FOR_SUBAGENTS } from '../tool-filtering.js';
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
} from '../../utils/worktree.js';
import { writeAgentOutput } from './output-writer.js';
import {
  writeAgentMetadata,
  readAgentMetadata,
  getAgentTranscript,
  saveAgentTranscript,
  writeAgentSystemPrompt,
} from '../agent-persistence.js';
import { sessionDir as getSessionDir, subAgentJsonlPath } from '../../core/session-store.js';
import {
  runAgentLoop,
  compressTranscript,
  extractToolCalls,
  enrichAgentPrompt,
  cleanupAgentWorktree,
  shortId,
  DEFAULT_MAX_TURNS,
  DEFAULT_CONTEXT_BUDGET,
} from '../agent-runner.js';

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
// Standard subagent path — explicit agent_type
// ---------------------------------------------------------------------------

/**
 * Shared completion handler for agents that finish in the background.
 * Handles cleanup, persistence, and notification.
 */
async function handleBackgroundedAgentCompletion(
  result: Awaited<ReturnType<typeof runAgentLoop>>,
  agentId: string,
  agentType: string,
  prompt: string,
  agentSpawn: AgentSpawnContext,
  subAbortController: AbortController,
  worktreePath: string | undefined,
  worktreeBranch: string | undefined,
  worktreeGitRoot: string | undefined,
  worktreeHeadCommit: string | undefined,
  worktreeHookBased: boolean | undefined,
  parentSessionDir: string | undefined,
  effectiveModel: string | undefined,
  bgSessionId: string | undefined,
  description: string | undefined,
): Promise<void> {
  let cleanupNote = '';
  if (worktreePath) {
    cleanupNote = await cleanupAgentWorktree({
      worktreePath, worktreeBranch, worktreeGitRoot, worktreeHeadCommit, worktreeHookBased,
    }, agentSpawn.hookManager);
  }

  const status = result.error ? 'error' : (subAbortController.signal.aborted ? 'stopped' : 'done');
  const compressed = compressTranscript(result.transcript);

  let outputPath: string | undefined;
  if (bgSessionId) {
    try {
      outputPath = await writeAgentOutput(bgSessionId, agentId, {
        status, agentType, prompt,
        turnCount: result.assistantTurnCount,
        toolCount: result.toolCount,
        elapsed: (Date.now() - result.startTime) / 1000,
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
    error: result.error,
    outputPath,
    tokenUsage: result.tokenUsage,
    liveToolCalls: [],
    transcript: undefined,
  });

  // Persist to disk for cross-session resume
  if (parentSessionDir) {
    writeAgentMetadata(agentId, {
      agentType, worktreePath, description: prompt, displayDescription: description,
      model: effectiveModel, createdAt: result.startTime, finishedAt: Date.now(),
      allowedTools: undefined,
      disallowedTools: undefined,
      permissionMode: 'auto',
      maxTurns: undefined,
      contextBudget: undefined,
    }, parentSessionDir).catch(() => {});
    saveAgentTranscript(agentId, result.transcript, parentSessionDir).catch(() => {});
  }

  agentSpawn.subAgentRegistry.notifyAgentCompletion(agentId);
}

async function executeStandardSubagent(
  input: Record<string, unknown>,
  agentSpawn: AgentSpawnContext,
  options: { cwd?: string; sessionId?: string; agentId?: string; toolUseId?: string },
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
  const isBackground = backgroundOverride ?? false;

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

  const effectiveModel = modelOverride ?? agentDef.model;

  // ── Worktree isolation ──────────────────────────────────────────────
  let worktreePath: string | undefined;
  let worktreeBranch: string | undefined;
  let worktreeGitRoot: string | undefined;
  let worktreeHeadCommit: string | undefined;
  let worktreeHookBased: boolean | undefined;
  const effectiveCwd = options.cwd ?? process.cwd();
  const parentSessionId = agentSpawn.sessionManager.getActive()?.id;
  const parentSessionDir = parentSessionId ? getSessionDir(parentSessionId) : undefined;

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

  // Save system prompt to disk (best-effort, mirrors main agent pattern)
  if (parentSessionDir) {
    writeAgentSystemPrompt(parentSessionDir, agentId, enrichedPrompt);
  }

  agentSpawn.subAgentRegistry.register({
    id: agentId,
    name: `${agentType}-${agentId}`,
    agentType: agentType as 'explore' | 'plan' | 'general-purpose',
    status: 'running',
    prompt,
    description,
    toolUseId: options.toolUseId,
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
        await handleBackgroundedAgentCompletion(
          result, agentId, agentType, prompt, agentSpawn,
          subAbortController, worktreePath, worktreeBranch,
          worktreeGitRoot, worktreeHeadCommit, worktreeHookBased,
          parentSessionDir, effectiveModel, bgSessionId, description,
        );
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
          liveToolCalls: [],
          transcript: undefined,
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

  // ── Sync path (with Ctrl+B background support) ──────────────────
  const subContext: SubagentContext = createSubagentContext(
    agentId, agentType, agentDef.source === 'built-in',
  );

  // Create background signal for Ctrl+B support
  let backgroundResolve: (() => void) | null = null;
  const backgroundPromise = new Promise<void>(resolve => { backgroundResolve = resolve; });
  agentSpawn.subAgentRegistry.update(agentId, { _backgroundResolve: backgroundResolve });

  const fgSessionId = options.sessionId;
  const raceStartTime = Date.now();

  const loopPromise = runWithAgentContext(subContext, () =>
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

  const raceResult = await Promise.race([
    loopPromise.then(r => ({ backgrounded: false as const, result: r })),
    backgroundPromise.then(() => ({ backgrounded: true as const })),
  ]);

  // Clean up resolver regardless of outcome
  agentSpawn.subAgentRegistry.update(agentId, { _backgroundResolve: null });

  if (raceResult.backgrounded) {
    // Agent was moved to background — switch to fire-and-forget
    loopPromise.then(async result => {
      await handleBackgroundedAgentCompletion(
        result, agentId, agentType, prompt, agentSpawn,
        subAbortController, worktreePath, worktreeBranch,
        worktreeGitRoot, worktreeHeadCommit, worktreeHookBased,
        parentSessionDir, effectiveModel, fgSessionId, description,
      );
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
        liveToolCalls: [],
        transcript: undefined,
      });
      agentSpawn.subAgentRegistry.notifyAgentCompletion(agentId);
    });

    return {
      content: `Sub-agent ${agentId} (${agentType}) moved to background. Results will be delivered when complete.${worktreePath ? ` (worktree: ${worktreePath})` : ''}`,
      isError: false,
      duration: Date.now() - raceStartTime,
      metadata: { agentId, agentType, background: true, worktreePath },
    };
  }

  const result = raceResult.result;

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
    error: result.error,
    transcript: undefined,
  });

  // Persist to disk for cross-session resume
  if (parentSessionDir) {
    writeAgentMetadata(agentId, {
      agentType, worktreePath, description: prompt, displayDescription: description,
      model: effectiveModel, createdAt: result.startTime, finishedAt: Date.now(),
      allowedTools: Array.isArray(agentDef.tools) ? agentDef.tools : undefined,
      disallowedTools: agentDef.disallowedTools,
      permissionMode: 'auto',
      maxTurns: agentDef.maxTurns,
      contextBudget: agentDef.contextBudget,
    }, parentSessionDir).catch(() => {});
    saveAgentTranscript(agentId, result.transcript, parentSessionDir).catch(() => {});
  }

  if (result.error) {
    return {
      content: `Sub-agent ${agentId} (${agentType}) error after ${result.assistantTurnCount} turns: ${result.error}${cleanupNote}`,
      isError: true,
      duration: Date.now() - result.startTime,
      metadata: { agentId, agentType, error: result.error, worktreePath },
    };
  }

  const transcriptPath = parentSessionDir ? subAgentJsonlPath(parentSessionDir, agentId) : '';

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
  background: boolean | undefined,
  agentSpawn: AgentSpawnContext,
  toolUseId?: string,
  bgSessionId?: string,
): Promise<ToolResult> {
  const agentType = 'fork';
  const agentId = `fork-${shortId()}`;
  const subAbortController = new AbortController();
  const isBackground = background ?? false;

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
  const forkSessionId = agentSpawn.sessionManager.getActive()?.id;
  const forkSessionDir = forkSessionId ? getSessionDir(forkSessionId) : undefined;

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
    toolUseId,
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
        await handleBackgroundedAgentCompletion(
          result, agentId, 'fork', prompt, agentSpawn,
          subAbortController, worktreePath, worktreeBranch,
          worktreeGitRoot, worktreeHeadCommit, worktreeHookBased,
          forkSessionDir, effectiveModel, forkBgSessionId, description,
        );
      }).catch(async err => {
        if (worktreePath) {
          await cleanupAgentWorktree({
            worktreePath, worktreeBranch, worktreeGitRoot, worktreeHeadCommit, worktreeHookBased,
          }, agentSpawn.hookManager).catch(() => {});
        }
        agentSpawn.subAgentRegistry.update(agentId, {
          status: 'error', finishedAt: Date.now(),
          error: err instanceof Error ? err.message : String(err),
          transcript: undefined,
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

  // Sync fork (with Ctrl+B background support)
  const forkContext: SubagentContext = createSubagentContext(agentId, 'fork', true);

  // Create background signal for Ctrl+B support
  let forkBgResolve: (() => void) | null = null;
  const forkBgPromise = new Promise<void>(resolve => { forkBgResolve = resolve; });
  agentSpawn.subAgentRegistry.update(agentId, { _backgroundResolve: forkBgResolve });

  const forkStartTime = Date.now();
  const forkLoopPromise = runWithAgentContext(forkContext, () =>
    runAgentLoop({
      agentId, agentType, prompt, agentSpawn,
      systemPromptText, effectiveModel, subToolRegistry, subAbortController,
      effectiveMaxTurns, effectiveContextBudget, initialMessages,
      cwd,
      enableCacheControl: true,
    }),
  );

  const forkRaceResult = await Promise.race([
    forkLoopPromise.then(r => ({ backgrounded: false as const, result: r })),
    forkBgPromise.then(() => ({ backgrounded: true as const })),
  ]);

  agentSpawn.subAgentRegistry.update(agentId, { _backgroundResolve: null });

  if (forkRaceResult.backgrounded) {
    forkLoopPromise.then(async result => {
      await handleBackgroundedAgentCompletion(
        result, agentId, 'fork', prompt, agentSpawn,
        subAbortController, worktreePath, worktreeBranch,
        worktreeGitRoot, worktreeHeadCommit, worktreeHookBased,
        forkSessionDir, effectiveModel, bgSessionId, description,
      );
    }).catch(async err => {
      if (worktreePath) {
        await cleanupAgentWorktree({
          worktreePath, worktreeBranch, worktreeGitRoot, worktreeHeadCommit, worktreeHookBased,
        }, agentSpawn.hookManager).catch(() => {});
      }
      agentSpawn.subAgentRegistry.update(agentId, {
        status: 'error', finishedAt: Date.now(),
        error: err instanceof Error ? err.message : String(err),
        transcript: undefined,
      });
      agentSpawn.subAgentRegistry.notifyAgentCompletion(agentId);
    });

    return {
      content: `Fork agent ${agentId} moved to background. Results will be delivered when complete.${worktreePath ? ` (worktree: ${worktreePath})` : ''}`,
      isError: false,
      duration: Date.now() - forkStartTime,
      metadata: { agentId, agentType: 'fork', background: true, worktreePath },
    };
  }

  const result = forkRaceResult.result;

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
    error: result.error,
    transcript: undefined,
  });

  // Persist to disk for cross-session resume
  if (forkSessionDir) {
    writeAgentMetadata(agentId, {
      agentType: 'fork', worktreePath, description: prompt, displayDescription: description,
      model: effectiveModel, createdAt: result.startTime, finishedAt: Date.now(),
      permissionMode: 'auto',
    }, forkSessionDir).catch(() => {});
    saveAgentTranscript(agentId, result.transcript, forkSessionDir).catch(() => {});
  }

  if (result.error) {
    return {
      content: `Fork agent ${agentId} error after ${result.assistantTurnCount} turns: ${result.error}${cleanupNote}`,
      isError: true,
      duration: Date.now() - result.startTime,
      metadata: { agentId, agentType: 'fork', error: result.error, worktreePath },
    };
  }

  const forkTranscriptPath = forkSessionDir ? subAgentJsonlPath(forkSessionDir, agentId) : '';

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
  const resumeSessionId = agentSpawn.sessionManager.getActive()?.id;
  const resumeSessionDir = resumeSessionId ? getSessionDir(resumeSessionId) : undefined;

  // ── Look up agent in registry ────────────────────────────────────────
  let agent = agentSpawn.subAgentRegistry.get(agentId);

  // ── Fallback: try loading from disk (cross-session resume) ──────────
  if (!agent) {
    if (!resumeSessionDir) {
      return {
        content: 'No active session directory available for disk fallback.',
        isError: true,
      };
    }
    const meta = await readAgentMetadata(agentId, resumeSessionDir);
    const transcript = await getAgentTranscript(agentId, resumeSessionDir);

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
    error: result.error,
    transcript: undefined,
  });

  // Persist updated transcript to disk
  if (resumeSessionDir) {
    saveAgentTranscript(agentId, cumulativeTranscript, resumeSessionDir).catch(() => {});
    writeAgentMetadata(agentId, {
      agentType, worktreePath: undefined, description: agent.prompt, displayDescription: agent.description,
      createdAt: agent.createdAt, finishedAt: Date.now(),
    }, resumeSessionDir).catch(() => {});
  }

  if (result.error) {
    return {
      content: `Sub-agent ${agentId} (${agentType}) resume error after ${result.assistantTurnCount} turns: ${result.error}`,
      isError: true,
      duration: Date.now() - result.startTime,
      metadata: { agentId, agentType, resumed: true, error: result.error },
    };
  }

  const resumeTranscriptPath = resumeSessionDir ? subAgentJsonlPath(resumeSessionDir, agentId) : '';

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
  const agentIdInput = input.agent_id as string | undefined;
  const resumeFlag = input.resume as boolean | undefined;

  // ── Path 1: Resume — agent_id + resume flag ───────────────────
  if (agentIdInput && resumeFlag) {
    return executeResume(agentIdInput, prompt, agentSpawn, {
      cwd: options.cwd,
      sessionId: options.sessionId,
    });
  }

  // ── Path 2: Fork mode — no agent_type (or "fork_main") → inherit parent context ────
  if ((!agentTypeInput || agentTypeInput === 'fork_main') && isForkSubagentEnabled()) {
    return executeFork(prompt, description, modelOverride, isolation, backgroundOverride, agentSpawn, options.toolUseId, options.sessionId);
  }

  // ── Path 3: Standard subagent — explicit agent_type ───────────────
  return executeStandardSubagent(input, agentSpawn, {
    cwd: options.cwd,
    sessionId: options.sessionId,
    agentId: options.agentId,
    toolUseId: options.toolUseId,
  });
};
