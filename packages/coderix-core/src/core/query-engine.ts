/**
 * QueryEngine — Session lifecycle manager
 *
 * Consumes the query() AsyncGenerator, manages session state,
 * and provides the main entry point for user interaction.
 *
 * Adapted from Coderix for ink-chat-tui.
 */

import type {
  Session,
  AssistantMessage,
  UserMessage,
  QueryMessage,
  StreamEvent,
  DeferredPermission,
  ContentBlock,
} from './types.js';
import type { DeferredQuestion } from './types.js';
import { PermissionMode, AgentError } from './types.js';
import { query, type QueryConfig, type CallModelParams } from './query.js';
import { ToolRegistry } from './tool-registry.js';
import { PermissionEngine } from './permission.js';
import { SystemPromptAssembler, type SystemPrompt } from './system-prompt.js';
import { SessionManager } from './session.js';
import { CheckpointManager } from './checkpoint.js';
import type { HookManager } from '../hooks/index.js';
import type { SubAgentRegistry } from './subagent-registry.js';
import type { AgentRegistry } from './agent-registry.js';
import { getAgentRole, getCoordinatorSystemContext } from '../teams/coordinator-mode.js';
import { drainUnreadMessages } from '../teams/team-mailbox.js';
import { execute as executeSendMessage } from '../teams/tools/team-message/executor.js';
import { filterToolsForResumedAgent, GLOBAL_DISALLOWED_FOR_SUBAGENTS } from '../agents/tool-filtering.js';
import {
  readAgentMetadata,
  getAgentTranscript,
  saveAgentTranscript,
  writeAgentMetadata,
} from '../agents/agent-persistence.js';
import type { CoderSettings, ModelItem, ModelEntry } from '../config.js';
import type { ToolResult } from '../tools/types.js';
import type { EventBus } from '../state/observable.js';
import type { CoreState } from '../state/core-state.js';
import {
  loadMemoryConfig,
} from '../memory/config.js';
import type { MemoryConfig } from '../memory/types.js';
import {
  executeExtractMemories,
  initExtractMemories as initMemoryExtraction,
  drainPendingExtraction as drainMemoryExtraction,
} from '../memory/extract-memories.js';
import {
  findRelevantMemories,
  formatRecalledMemories,
  RelevanceCache,
} from '../memory/recall.js';
import { ReadFileTracker } from './read-file-tracker.js';
import { MessageQueue } from './message-queue.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QueryEngineConfig {
  cwd: string;
  toolRegistry: ToolRegistry;
  sessionManager: SessionManager;
  maxTurns?: number;
  maxBudgetUsd?: number;
  contextBudget?: number;
  compactThreshold?: number;
  customSystemPrompt?: string;
  appendSystemPrompt?: string;
  model?: string;
  /** Max concurrent tool executions (default: 32). */
  maxToolConcurrency?: number;
  callModel: (params: CallModelParams) => AsyncGenerator<StreamEvent | AssistantMessage>;
  /** Optional HookManager for lifecycle hook execution */
  hookManager?: HookManager;
  /** SubAgentRegistry for tracking spawned sub-agents */
  subAgentRegistry?: SubAgentRegistry;
  /** SystemPromptAssembler for assembling worker/coordinator prompts */
  systemPromptAssembler?: SystemPromptAssembler;
  /** AgentRegistry for agent type definitions */
  agentRegistry?: AgentRegistry;
  /** CoderSettings for coordinator mode detection */
  settings?: CoderSettings;
  /** Active team name (when running in coordinator mode) */
  teamName?: string;
  /** EventBus for decoupled frontend communication.
   *  Engine events are emitted to both AsyncGenerator AND
   *  eventBus.engineEvents Observable. */
  eventBus?: EventBus;
  /** Enable brief/concise mode to reduce response verbosity. */
  briefMode?: boolean;
  /** Enable automatic context compaction. When false, only manual /compact works. */
  autoCompactEnabled?: boolean;
}

export interface QueryEngineEvent {
  type: 'message' | 'error' | 'cost' | 'compact' | 'done' | 'permission_required' | 'question_required' | 'queued';
  data?: unknown;
  deferred?: DeferredPermission | DeferredQuestion;
}

// ---------------------------------------------------------------------------
// QueryEngine
// ---------------------------------------------------------------------------

export class QueryEngine {
  private config: QueryEngineConfig;
  private permissionEngine: PermissionEngine;
  private abortController: AbortController | null = null;
  private checkpointManager: CheckpointManager;
  private systemPrompt: SystemPrompt | null = null;
  private memoryConfig: MemoryConfig;
  private relevanceCache = new RelevanceCache();
  private readFileTracker = new ReadFileTracker();
  private isActive = false;
  private messageQueue = new MessageQueue();
  private runningToolCount = 0;

  constructor(config: QueryEngineConfig) {
    this.config = {
      maxTurns: 500,
      contextBudget: 180_000,
      compactThreshold: 0.85,
      model: 'deepseek-v4-pro',
      ...config,
    };

    // Derive contextBudget from the model's actual context window
    // when no explicit budget was set.  Falls back to the hardcoded
    // 180_000 default when model_list has no max_context info.
    if (
      config.contextBudget === undefined &&
      config.settings?.model_list &&
      config.model
    ) {
      const budget = resolveModelMaxContext(
        config.model,
        config.settings.model_list,
      );
      if (budget) {
        this.config.contextBudget = budget;
      }
    }

    this.permissionEngine = new PermissionEngine(config.cwd);
    this.checkpointManager = new CheckpointManager();
    this.memoryConfig = loadMemoryConfig(config.settings?.memory);
    initMemoryExtraction();
  }

  async init(): Promise<void> {
    const assembler = this.config.systemPromptAssembler ?? new SystemPromptAssembler();
    const agentRole = getAgentRole(this.config.settings);

    // If coordinator with team active, inject team context into append prompt
    let appendPrompt = this.config.appendSystemPrompt;
    if (agentRole === 'coordinator' && this.config.teamName) {
      const teamCtx = await getCoordinatorSystemContext(this.config.teamName);
      if (teamCtx) {
        appendPrompt = appendPrompt ? `${appendPrompt}\n\n${teamCtx}` : teamCtx;
      }
    }

    this.systemPrompt = await assembler.assemble({
      cwd: this.config.cwd,
      permissionMode: this.permissionEngine.getMode(),
      customPrompt: this.config.customSystemPrompt,
      appendPrompt,
      agentRole,
      model: this.config.model,
      memorySettings: this.config.settings?.memory,
      briefMode: this.config.briefMode ?? false,
      agentRegistry: this.config.agentRegistry,
    });

    // Setup hook (non-blockable, fires on first init)
    if (this.config.hookManager) {
      const session = this.config.sessionManager.getActive();
      if (session && session.messages.length === 0) {
        this.config.hookManager.onSetup(
          session.id,
          this.config.cwd,
          true,
          this.config.model,
          undefined,
        ).catch(() => {});
      }
    }
  }

  /**
   * Toggle brief mode on/off at runtime. Forces system prompt rebuild
   * so the directive is injected (or removed) on the next turn.
   */
  setBriefMode(enabled: boolean): void {
    if (this.config.briefMode === enabled) return;
    this.config.briefMode = enabled;
    this.systemPrompt = null; // force reassembly on next submitMessage
  }

  /**
   * Clear transient caches after compaction. Prevents stale state
   * from polluting new conversation turns.
   */
  clearCaches(): void {
    this.relevanceCache.clear();
    this.readFileTracker.clear();
  }

  async *submitMessage(userInput: string): AsyncGenerator<QueryEngineEvent> {
    const eventBus = this.config.eventBus;

    const emitEarly = (event: QueryEngineEvent): void => {
      if (eventBus) {
        try { eventBus.engineEvents.next(event); } catch { /* best-effort */ }
      }
    };

    // Decision tree: if already active, enqueue or abort based on running tools
    if (this.isActive) {
      const hasBlocking = this.hasBlockingToolsRunning();
      if (hasBlocking) {
        this.messageQueue.enqueue(userInput);
        const event: QueryEngineEvent = {
          type: 'queued',
          data: { position: this.messageQueue.length },
        };
        emitEarly(event);
        yield event;
        return;
      }
      // All running tools are cancel-safe — abort and proceed
      if (this.abortController) {
        this.abortController.abort();
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    this.isActive = true;

    const session = this.config.sessionManager.getActive();
    this.abortController = new AbortController();

    // Handle orphaned tool_use blocks from prior interrupted turn
    const lastMsg = session.messages.length > 0
      ? session.messages[session.messages.length - 1]
      : null;
    const MISSING_RESULT_PROMPT =
      'A new user message arrived while tools were executing. ' +
      'The pending tool use results are unavailable.';

    if (lastMsg && lastMsg.role === 'assistant' && Array.isArray(lastMsg.content)) {
      const toolUseBlocks = lastMsg.content.filter((b) => b.type === 'tool_use');
      if (toolUseBlocks.length > 0) {
        const errorResults: ContentBlock[] = toolUseBlocks.map((b) => ({
          type: 'tool_result' as const,
          tool_use_id: b.id!,
          content: MISSING_RESULT_PROMPT,
          is_error: true,
        }));
        this.config.sessionManager.addMessage({
          role: 'user',
          content: errorResults,
        });
      }
    }

    // === UserPromptSubmit hook (blockable) ===
    let effectiveInput = userInput;
    if (this.config.hookManager) {
      const result = await this.config.hookManager.onUserPromptSubmit(
        session.id,
        this.config.cwd,
        userInput,
        { model: this.config.model, provider: undefined },
      );
      if (result.blocked) {
        const event: QueryEngineEvent = {
          type: 'error',
          data: new AgentError(
            result.blockReason ?? 'Prompt blocked by UserPromptSubmit hook',
            'HOOK_BLOCKED',
          ),
        };
        emitEarly(event);
        yield event;
        return;
      }
      if (result.augmentedPrompt) {
        effectiveInput = result.augmentedPrompt;
      }

      // UserPromptExpansion hook (blockable)
      const expansionResult = await this.config.hookManager.onUserPromptExpansion(
        session.id,
        this.config.cwd,
        userInput,
        effectiveInput,
      );
      if (expansionResult.blocked) {
        const event: QueryEngineEvent = {
          type: 'error',
          data: new AgentError(
            expansionResult.blockReason ?? 'Prompt blocked by UserPromptExpansion hook',
            'HOOK_BLOCKED',
          ),
        };
        emitEarly(event);
        yield event;
        return;
      }
      if (expansionResult.expandedPromptOverride) {
        effectiveInput = expansionResult.expandedPromptOverride;
      }
    }

    const userMessage: UserMessage = { role: 'user', content: effectiveInput };

    // Inject completed background agent results as system context
    if (this.config.subAgentRegistry) {
      const notifications = this.config.subAgentRegistry.drainNotifications();
      if (notifications.length > 0) {
        const contextBlock: ContentBlock = {
          type: 'text',
          text: '<background-agent-notifications>\n' + notifications.join('\n\n') + '\n</background-agent-notifications>',
        };
        this.config.sessionManager.addMessage({
          role: 'user',
          content: [contextBlock],
        });
      }
    }

    // Drain team messages for coordinator (inject unread messages as context)
    if (this.config.teamName && this.config.settings) {
      const leaderName = 'leader';
      const teamMsgs = await drainUnreadMessages(this.config.teamName, leaderName);
      if (teamMsgs.length > 0) {
        const msgsText = teamMsgs.map(m =>
          `[${m.from} → ${m.to}]: ${m.text}`
        ).join('\n');
        const contextBlock: ContentBlock = {
          type: 'text',
          text: '[Team messages]\n' + msgsText,
        };
        this.config.sessionManager.addMessage({
          role: 'user',
          content: [contextBlock],
        });
      }
    }

    this.config.sessionManager.addMessage(userMessage);

    // Memory recall: search for relevant memories and inject as system context
    if (this.memoryConfig.enabled && this.memoryConfig.recallEnabled) {
      const ac = new AbortController();
      try {
        const recalled = await findRelevantMemories(
          effectiveInput,
          this.config.cwd,
          this.memoryConfig,
          this.relevanceCache.getSurfaced(),
          ac.signal,
        );
        if (recalled.length > 0) {
          const contextText = formatRecalledMemories(recalled);
          const contextBlock: ContentBlock = {
            type: 'text',
            text: contextText,
          };
          this.config.sessionManager.addMessage({
            role: 'user',
            content: [contextBlock],
          });
          this.relevanceCache.markSurfaced(recalled.map(r => r.path));
        }
      } catch {
        // Recall is best-effort — don't break the query on errors
      }
    }

    if (!this.systemPrompt) {
      await this.init();
    }

    const getCoreState = (): CoreState => ({
      sessionId: session.id,
      permissionMode: this.permissionEngine.getMode() as 'plan' | 'ask' | 'auto',
      model: this.config.model ?? 'unknown',
      config: {
        cwd: this.config.cwd,
        model: this.config.model ?? 'unknown',
        baseUrl: '',
        apiKey: '',
        inputPrice: 0,
        outputPrice: 0,
        cacheReadPrice: 0,
        maxContext: this.config.contextBudget ?? 180_000,
        briefMode: this.config.briefMode ?? false,
        autoCompactEnabled: this.config.autoCompactEnabled ?? true,
        compactThreshold: this.config.compactThreshold ?? 0.85,
      },
    });

    // Trim session.messages to prevent unbounded growth.
    // The query loop compacts its local copy independently, so the session
    // only needs to retain enough messages to reconstruct context on resume.
    const trimBudget = this.config.contextBudget ?? 180_000;
    this.config.sessionManager.trimMessages(trimBudget);

    // Resolve autoCompactEnabled: config key + env var override
    const autoCompactEnabled = (() => {
      if (process.env.DISABLE_COMPACT || process.env.DISABLE_AUTO_COMPACT) {
        return false;
      }
      return this.config.autoCompactEnabled ?? true;
    })();

    // Resolve compactThreshold: env var > settings > default (0.85)
    const resolvedCompactThreshold = (() => {
      const envOverride = process.env.CODERRX_AUTOCOMPACT_PCT_OVERRIDE;
      if (envOverride) {
        const pct = parseFloat(envOverride);
        if (!isNaN(pct) && pct > 0 && pct <= 100) {
          return pct / 100;
        }
      }
      return this.config.compactThreshold!;
    })();

    const queryConfig: QueryConfig = {
      sessionId: session.id,
      cwd: this.config.cwd,
      messages: [...session.messages],
      systemPrompt: this.systemPrompt!,
      toolRegistry: this.config.toolRegistry,
      permissionEngine: this.permissionEngine,
      sessionManager: this.config.sessionManager,
      checkpointManager: this.checkpointManager,
      abortController: this.abortController,
      maxTurns: this.config.maxTurns!,
      maxBudgetUsd: this.config.maxBudgetUsd,
      contextBudget: this.config.contextBudget!,
      compactThreshold: resolvedCompactThreshold,
      autoCompactEnabled,
      maxToolConcurrency: this.config.maxToolConcurrency,
      callModel: this.config.callModel,
      hookManager: this.config.hookManager,
      subAgentRegistry: this.config.subAgentRegistry,
      systemPromptAssembler: this.config.systemPromptAssembler,
      agentRegistry: this.config.agentRegistry,
      agentRole: getAgentRole(this.config.settings),
      getCoreState,
      emitToolRequest: eventBus
        ? (req) => eventBus.toolRequests.next(req)
        : undefined,
      onToolQueueChange: (count) => { this.runningToolCount = count; },
    };

    // Dual-write helper: yields the event AND emits to EventBus (if configured)
    const emit = (event: QueryEngineEvent): void => {
      if (eventBus) {
        try { eventBus.engineEvents.next(event); } catch { /* best-effort */ }
      }
    };

    try {
      for await (const msg of query(queryConfig)) {
        switch (msg.type) {
          case 'stream_event': {
            const event = { type: 'message' as const, data: msg };
            emit(event);
            yield event;
            break;
          }
          case 'assistant': {
            this.config.sessionManager.addMessage(msg.message);
            const event = { type: 'message' as const, data: msg };
            emit(event);
            yield event;
            break;
          }
          case 'user': {
            this.config.sessionManager.addMessage(msg.message);
            const event = { type: 'message' as const, data: msg };
            emit(event);
            yield event;
            break;
          }
          case 'system':
            if (msg.subtype === 'compact_boundary') {
              const event = { type: 'compact' as const, data: msg.compactMetadata };
              emit(event);
              yield event;
            } else if (msg.subtype === 'error') {
              const event = { type: 'error' as const, data: msg.error };
              emit(event);
              yield event;
            } else if (msg.subtype === 'progress' || msg.subtype === 'tool_completed') {
              const event = { type: 'message' as const, data: msg };
              emit(event);
              yield event;
            } else if (msg.subtype === 'permission_required') {
              const event = { type: 'permission_required' as const, data: msg.deferred, deferred: msg.deferred };
              emit(event);
              yield event;
            } else if (msg.subtype === 'question_required') {
              const event = { type: 'question_required' as const, data: msg.deferred, deferred: msg.deferred };
              emit(event);
              yield event;
            }
            break;
        }
      }
      const doneEvent: QueryEngineEvent = { type: 'done', data: { sessionId: session.id } };
      emit(doneEvent);
      yield doneEvent;

      // Memory extraction: fire-and-forget background extraction
      if (this.memoryConfig.enabled && this.memoryConfig.autoExtract) {
        executeExtractMemories(
          session.messages,
          this.config.cwd,
          this.memoryConfig,
          null, // callModel — wired in Phase 5 (integration)
        );
      }
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const errorEvent: QueryEngineEvent = { type: 'error', data: { message: errMsg } };
      emit(errorEvent);
      yield errorEvent;
      throw error;
    } finally {
      this.isActive = false;
      this.config.sessionManager.saveSession(session);
      this.messageQueue.drainNext();
    }
  }

  interrupt(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  /** Subscribe to queue drain events. Returns unsubscribe function.
   *  When a queued message is ready to process (current turn completed),
   *  the callback is invoked with the message text. */
  onQueueDrain(callback: (message: string) => void): () => void {
    return this.messageQueue.onDrain(callback);
  }

  /** Check whether any running tool has interruptBehavior: 'block'.
   *  If tools are running but we don't know which, be conservative and block. */
  private hasBlockingToolsRunning(): boolean {
    return this.runningToolCount > 0;
  }

  /** Send a follow-up message to a completed/stopped sub-agent, resuming its execution. */
  async sendSubAgentMessage(agentId: string, message: string): Promise<ToolResult> {
    const { subAgentRegistry, toolRegistry, sessionManager, callModel, hookManager, systemPromptAssembler, agentRegistry } = this.config;
    if (!subAgentRegistry || !systemPromptAssembler || !agentRegistry) {
      return { content: 'Sub-agent infrastructure not available.', isError: true };
    }

    return executeSendMessage(
      { agent_id: agentId, message },
      {
        sessionId: sessionManager.getActive().id,
        cwd: this.config.cwd,
        allowMutation: true,
        maxOutput: 200_000,
        bashTimeout: 120_000,
        agentSpawn: {
          callModel,
          toolRegistry,
          sessionManager,
          subAgentRegistry,
          hookManager,
          systemPromptAssembler,
          agentRegistry,
        },
      },
    );
  }

  /**
   * Streaming version of sendSubAgentMessage.
   * Yields QueryEngineEvents as the sub-agent runs, so the TUI can render
   * messages in real-time. Updates the registry transcript on completion.
   */
  async *sendSubAgentMessageStreaming(
    agentId: string,
    message: string,
  ): AsyncGenerator<QueryEngineEvent> {
    const { subAgentRegistry, toolRegistry, callModel, hookManager, systemPromptAssembler, agentRegistry } = this.config;
    if (!subAgentRegistry || !systemPromptAssembler || !agentRegistry) {
      yield { type: 'error', data: { message: 'Sub-agent infrastructure not available.' } };
      return;
    }

    // ── Resolve agent (with disk fallback) ──────────────────────────
    let agent = subAgentRegistry.get(agentId);

    if (!agent) {
      const meta = await readAgentMetadata(agentId);
      const diskTranscript = await getAgentTranscript(agentId);

      if (!meta || !diskTranscript) {
        yield {
          type: 'error',
          data: { message: `Agent '${agentId}' not found in registry or on disk.` },
        };
        return;
      }

      const diskAbortController = new AbortController();
      subAgentRegistry.register({
        id: agentId,
        name: `${meta.agentType}-${agentId}`,
        agentType: (meta.agentType as any) || 'general-purpose',
        status: 'stopped',
        prompt: meta.description ?? '',
        createdAt: meta.createdAt,
        turnCount: diskTranscript.filter((m: any) => m.role === 'assistant').length,
        messageCount: diskTranscript.length,
        toolCount: 0,
        abortController: diskAbortController,
        notified: true,
        transcript: diskTranscript,
      });

      agent = subAgentRegistry.get(agentId);
      if (!agent) {
        yield { type: 'error', data: { message: `Failed to re-register agent '${agentId}' from disk.` } };
        return;
      }
    }

    if (agent.status === 'running') {
      yield {
        type: 'error',
        data: { message: `Cannot message running agent '${agentId}'. Wait for it to complete.` },
      };
      return;
    }

    const transcript = agent.transcript ?? [];
    const agentType = agent.agentType;
    const agentDef = agentRegistry.get(agentType);

    // ── Build resumed messages ──────────────────────────────────────
    const resumedMessages: any[] = [
      ...trimTranscriptForResume(transcript),
      { role: 'user', content: message },
    ];

    // ── Build sub-agent tooling ─────────────────────────────────────
    const parentDefs = toolRegistry.getDefinitions();
    const filteredDefs = agentDef
      ? filterToolsForResumedAgent(parentDefs, agentDef)
      : parentDefs.filter(t => !GLOBAL_DISALLOWED_FOR_SUBAGENTS.has(t.name));
    const subToolRegistry = new ToolRegistry();
    for (const def of filteredDefs) {
      const registration = toolRegistry.get(def.name);
      if (registration) {
        subToolRegistry.register(def, registration.execute);
      }
    }

    const subPermissionEngine = new PermissionEngine(process.cwd());
    subPermissionEngine.setMode(PermissionMode.AUTO);

    const subSessionManager = new SessionManager();
    subSessionManager.create({
      title: `Sub-agent: ${agentType} (resumed)`,
      cwd: process.cwd(),
      parentSessionId: this.config.sessionManager.getActive()?.id,
    });

    const subCheckpointManager = new CheckpointManager();

    // ── Build system prompt ─────────────────────────────────────────
    let systemPromptText: string;
    if (agentDef) {
      try {
        const workerPrompt = await systemPromptAssembler.assemble({
          cwd: process.cwd(),
          permissionMode: 'auto',
          agentRole: 'worker',
        });
        const envPart = workerPrompt.parts.find(p => p.name === 'env_info');
        const permPart = workerPrompt.parts.find(p => p.name === 'permission_mode');
        const extra = [envPart?.content, permPart?.content].filter(Boolean).join('\n\n');
        systemPromptText = extra
          ? agentDef.getSystemPrompt() + '\n\n' + extra
          : agentDef.getSystemPrompt();
      } catch {
        systemPromptText = agentDef.getSystemPrompt();
      }
    } else {
      systemPromptText = [
        'You are a sub-agent worker spawned by Coderix to complete a specific task.',
        'Complete the task efficiently using the tools available to you.',
        'You CANNOT spawn additional sub-agents.',
        'Do not ask the user questions — you operate autonomously.',
      ].join('\n');
    }

    const workerPrompt: SystemPrompt = {
      prompt: systemPromptText,
      parts: [{ name: `agent-${agentType}`, content: systemPromptText, priority: 0 }],
    };

    const subAbortController = new AbortController();
    subAgentRegistry.update(agentId, {
      status: 'running',
      abortController: subAbortController,
    });

    // ── Run the query loop ──────────────────────────────────────────
    let assistantTurnCount = 0;
    let toolCount = 0;
    const newTranscript: any[] = [];

    try {
      const generator = query({
        sessionId: subSessionManager.getActive().id,
        cwd: process.cwd(),
        messages: resumedMessages,
        systemPrompt: workerPrompt,
        toolRegistry: subToolRegistry,
        permissionEngine: subPermissionEngine,
        sessionManager: subSessionManager,
        checkpointManager: subCheckpointManager,
        abortController: subAbortController,
        maxTurns: agentDef?.maxTurns ?? 200,
        contextBudget: agentDef?.contextBudget ?? 120_000,
        compactThreshold: 0.85,
        autoCompactEnabled: this.config.autoCompactEnabled ?? true,
        callModel: this.config.callModel,
        hookManager,
      });

      for await (const msg of generator) {
        if (subAbortController.signal.aborted) break;

        switch (msg.type) {
          case 'stream_event': {
            yield { type: 'message', data: msg };
            break;
          }
          case 'assistant': {
            assistantTurnCount++;
            newTranscript.push(msg.message);
            const blocks = Array.isArray(msg.message.content) ? msg.message.content : [];
            toolCount += blocks.filter((b: any) => b.type === 'tool_use').length;
            yield { type: 'message', data: msg };
            break;
          }
          case 'user': {
            newTranscript.push(msg.message);
            yield { type: 'message', data: msg };
            break;
          }
          case 'system': {
            if (msg.subtype === 'progress') {
              const usage = subSessionManager.getActive().tokenUsage;
              subAgentRegistry.update(agentId, {
                turnCount: agent.turnCount + assistantTurnCount,
                messageCount: transcript.length + newTranscript.length,
                toolCount: agent.toolCount + toolCount,
                tokenUsage: {
                  inputTokens: usage.inputTokens,
                  outputTokens: usage.outputTokens,
                  cacheCreationInputTokens: usage.cacheCreationInputTokens,
                  cacheReadInputTokens: usage.cacheReadInputTokens,
                  totalTokens: usage.totalTokens,
                },
              });
            }
            if (msg.subtype === 'permission_required') {
              yield { type: 'permission_required', deferred: msg.deferred };
            } else if (msg.subtype === 'question_required') {
              yield { type: 'question_required', deferred: msg.deferred };
            } else if (msg.subtype === 'error') {
              yield { type: 'error', data: { message: msg.error.message } };
            } else {
              yield { type: 'message', data: msg };
            }
            break;
          }
        }
      }

      // ── Finalize ──────────────────────────────────────────────────
      const cumulativeTranscript = [...transcript, ...newTranscript];
      const finalUsage = subSessionManager.getActive().tokenUsage;
      subAgentRegistry.update(agentId, {
        status: subAbortController.signal.aborted ? 'stopped' : 'done',
        finishedAt: Date.now(),
        turnCount: agent.turnCount + assistantTurnCount,
        messageCount: cumulativeTranscript.length,
        toolCount: agent.toolCount + toolCount,
        transcript: cumulativeTranscript,
        tokenUsage: {
          inputTokens: finalUsage.inputTokens,
          outputTokens: finalUsage.outputTokens,
          cacheCreationInputTokens: finalUsage.cacheCreationInputTokens,
          cacheReadInputTokens: finalUsage.cacheReadInputTokens,
          totalTokens: finalUsage.totalTokens,
        },
      });

      saveAgentTranscript(agentId, cumulativeTranscript).catch(() => {});
      writeAgentMetadata(agentId, {
        agentType,
        worktreePath: undefined,
        description: agent.prompt,
        createdAt: agent.createdAt,
        finishedAt: Date.now(),
      }).catch(() => {});

      yield {
        type: 'done',
        data: { sessionId: subSessionManager.getActive().id, agentId },
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const errorUsage = subSessionManager.getActive().tokenUsage;
      subAgentRegistry.update(agentId, {
        status: 'error',
        finishedAt: Date.now(),
        turnCount: agent.turnCount + assistantTurnCount,
        error: errorMsg,
        tokenUsage: {
          inputTokens: errorUsage.inputTokens,
          outputTokens: errorUsage.outputTokens,
          cacheCreationInputTokens: errorUsage.cacheCreationInputTokens,
          cacheReadInputTokens: errorUsage.cacheReadInputTokens,
          totalTokens: errorUsage.totalTokens,
        },
      });
      yield { type: 'error', data: { message: errorMsg } };
    }
  }

  async resume(sessionId: string): Promise<Session> {
    const session = this.config.sessionManager.resume(sessionId);
    this.permissionEngine.setCwd(session.cwd);
    this.checkpointManager.loadFromDisk(sessionId);
    return session;
  }

  fork(fromTurn?: number): Session {
    const session = this.config.sessionManager.getActive();
    return this.config.sessionManager.fork({ sessionId: session.id, fromTurn, cwd: this.config.cwd });
  }

  rewind(toTurn: number): Session {
    const session = this.config.sessionManager.getActive();
    return this.config.sessionManager.rewind(session.id, toTurn);
  }

  getPermissionEngine(): PermissionEngine {
    return this.permissionEngine;
  }

  getSessionManager(): SessionManager {
    return this.config.sessionManager;
  }

  setPermissionMode(mode: PermissionMode): void {
    this.permissionEngine.setMode(mode);

    // ConfigChange hook (non-blockable)
    if (this.config.hookManager) {
      try {
        const session = this.config.sessionManager.getActive();
        if (session) {
          this.config.hookManager.onConfigChange(
            session.id,
            this.config.cwd,
            ['permissionMode'],
            { permissionMode: mode },
            undefined,
          ).catch(() => {});
        }
      } catch {
        // Non-blockable: session may not be active yet
      }
    }
  }

  async shutdown(): Promise<void> {
    this.interrupt();
    const session = this.config.sessionManager.getActive();
    this.config.sessionManager.saveSession(session);
    // Drain pending memory extraction before shutdown
    await drainMemoryExtraction(30_000);
  }

}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const modelName = (m: string | ModelItem): string =>
  typeof m === 'string' ? m : m.name;

const modelMaxContext = (m: string | ModelItem): number | undefined =>
  typeof m === 'string' ? undefined : m.price?.max_context;

/**
 * Look up a model's max context window from settings.model_list.
 *
 * Resolution order matches Coderix's model resolution:
 *   1. Find the model by exact name in any entry's model list
 *   2. If not found, use the first model in the first entry
 *   3. If nothing works, return undefined
 */
/** Trim large tool outputs in historical messages to prevent context bloat
 *  across repeated sub-agent resumes. Caps tool_result content at a limit so
 *  the model still sees all the context without O(N) duplication of giant
 *  outputs from prior turns. */
function trimTranscriptForResume(messages: any[]): any[] {
  const MAX_TOOL_OUTPUT = 4000;
  return messages.map((msg) => {
    if (msg.role !== 'user') return msg;
    const content = Array.isArray(msg.content) ? msg.content : [];
    const hasLargeOutput = content.some(
      (b: any) => b.type === 'tool_result' && typeof b.content === 'string'
        && b.content.length > MAX_TOOL_OUTPUT,
    );
    if (!hasLargeOutput) return msg;
    return {
      ...msg,
      content: content.map((b: any) => {
        if (b.type !== 'tool_result' || typeof b.content !== 'string'
            || b.content.length <= MAX_TOOL_OUTPUT) return b;
        return {
          ...b,
          content: b.content.slice(0, MAX_TOOL_OUTPUT)
            + `\n... [trimmed ${b.content.length - MAX_TOOL_OUTPUT} chars]`,
        };
      }),
    };
  });
}

function resolveModelMaxContext(
  model: string,
  modelList: ModelEntry[],
): number | undefined {
  for (const entry of modelList) {
    const found = entry.model.find((m) => modelName(m) === model);
    if (found) {
      return modelMaxContext(found);
    }
  }
  // Fallback: first model of first entry
  if (modelList.length > 0) {
    const first = modelList[0]!.model[0];
    if (first) return modelMaxContext(first);
  }
  return undefined;
}
