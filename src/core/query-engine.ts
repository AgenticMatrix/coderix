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
import { execute as executeAgentMessage } from '../agents/agent-message/executor.js';
import type { CoderSettings, ModelItem, ModelEntry } from '../cli/config.js';
import type { ToolResult } from '../tools/types.js';
import type { AppState } from '../state/AppState.js';
import type { Store } from '../state/store.js';
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
  /** Unified AppState store (injected so tools can read/write AppState directly). */
  appStore?: Store<AppState>;
}

export interface QueryEngineEvent {
  type: 'message' | 'error' | 'cost' | 'compact' | 'done' | 'permission_required' | 'question_required';
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

  constructor(config: QueryEngineConfig) {
    this.config = {
      maxTurns: 100,
      contextBudget: 180_000,
      compactThreshold: 0.7,
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

  async *submitMessage(userInput: string): AsyncGenerator<QueryEngineEvent> {
    // Abort any in-progress query
    if (this.abortController) {
      this.abortController.abort();
      await new Promise(resolve => setTimeout(resolve, 0));
    }

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
        yield {
          type: 'error',
          data: new AgentError(
            result.blockReason ?? 'Prompt blocked by UserPromptSubmit hook',
            'HOOK_BLOCKED',
          ),
        };
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
        yield {
          type: 'error',
          data: new AgentError(
            expansionResult.blockReason ?? 'Prompt blocked by UserPromptExpansion hook',
            'HOOK_BLOCKED',
          ),
        };
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
      const coordinatorName = 'coordinator';
      const teamMsgs = await drainUnreadMessages(this.config.teamName, coordinatorName);
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

    const appStore = this.config.appStore;
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
      compactThreshold: this.config.compactThreshold!,
      maxToolConcurrency: this.config.maxToolConcurrency,
      callModel: this.config.callModel,
      hookManager: this.config.hookManager,
      subAgentRegistry: this.config.subAgentRegistry,
      systemPromptAssembler: this.config.systemPromptAssembler,
      agentRegistry: this.config.agentRegistry,
      agentRole: getAgentRole(this.config.settings),
      getAppState: appStore ? () => appStore.getState() : undefined,
      setAppState: appStore ? (p) => appStore.setState(p) : undefined,
    };

    try {
      for await (const msg of query(queryConfig)) {
        switch (msg.type) {
          case 'stream_event':
            yield { type: 'message', data: msg };
            break;
          case 'assistant':
            this.config.sessionManager.addMessage(msg.message);
            yield { type: 'message', data: msg };
            break;
          case 'user':
            this.config.sessionManager.addMessage(msg.message);
            yield { type: 'message', data: msg };
            break;
          case 'system':
            if (msg.subtype === 'compact_boundary') {
              yield { type: 'compact', data: msg.compactMetadata };
            } else if (msg.subtype === 'error') {
              yield { type: 'error', data: msg.error };
            } else if (msg.subtype === 'progress') {
              yield { type: 'message', data: msg };
            } else if (msg.subtype === 'permission_required') {
              yield { type: 'permission_required', data: msg.deferred, deferred: msg.deferred };
            } else if (msg.subtype === 'question_required') {
              yield { type: 'question_required', data: msg.deferred, deferred: msg.deferred };
            }
            break;
        }
      }
      yield { type: 'done', data: { sessionId: session.id } };

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
      yield { type: 'error', data: { message: errMsg } };
      throw error;
    } finally {
      this.config.sessionManager.saveSession(session);
    }
  }

  interrupt(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  /** Send a follow-up message to a completed/stopped sub-agent, resuming its execution. */
  async sendSubAgentMessage(agentId: string, message: string): Promise<ToolResult> {
    const { subAgentRegistry, toolRegistry, sessionManager, callModel, hookManager, systemPromptAssembler, agentRegistry } = this.config;
    if (!subAgentRegistry || !systemPromptAssembler || !agentRegistry) {
      return { content: 'Sub-agent infrastructure not available.', isError: true };
    }

    return executeAgentMessage(
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

  /** Inject the AppState store after construction (TUI creates store after engine init). */
  setAppStore(store: Store<AppState>): void {
    this.config.appStore = store;
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
