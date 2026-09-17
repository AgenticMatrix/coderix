/**
 * engine-builder.ts — assemble a full QueryEngine from SDK Options.
 *
 * Replicates the bootstrap sequence the CLI already uses
 * (see packages/coderix-cli/src/cli/main.tsx `runPrintMode` and
 *  packages/coderix-cli/src/gateway/server.ts `startGateway`),
 * but parameterized by the claude-code-sdk-shaped `Options`.
 */

import {
  loadConfig,
  loadSettings,
  getMaxToolConcurrency,
  createCallModel,
  SessionManager,
  ToolRegistry,
  QueryEngine,
  SubAgentRegistry,
  SystemPromptAssembler,
  buildAgentRegistry,
  McpManager,
  connectToServer,
  discoverTools,
  plugins,
  RiskLevel,
  toCorePermissionMode,
} from '@coderix/core';
import type {
  AppConfig,
  CoderSettings,
  ToolPlugin,
  ToolContext,
  ScopedServerConfig,
  SdkOptions as Options,
  SystemPromptConfig,
  AgentRegistry,
} from '@coderix/core';

export interface BuiltEngine {
  engine: QueryEngine;
  sessionManager: SessionManager;
  toolRegistry: ToolRegistry;
  config: AppConfig;
  model: string;
  settings: CoderSettings;
  cwd: string;
  mcpServerNames: string[];
  /** Shut the engine down (session + in-flight turns). */
  dispose: () => Promise<void>;
}

/**
 * Shared, connection-heavy engine resources reused across many per-query
 * engines. `toolRegistry` (incl. programmatic MCP connections), the agent
 * registry, and the (stateless) system-prompt assembler are safe to share
 * read-only; each query gets its own session, sub-agent registry, callModel
 * and QueryEngine (see buildEngineFromTemplate).
 */
export interface EngineTemplate {
  config: AppConfig;
  model: string;
  settings: CoderSettings;
  cwd: string;
  toolRegistry: ToolRegistry;
  mcpServerNames: string[];
  systemPromptAssembler: SystemPromptAssembler;
  agentRegistry: AgentRegistry;
  /** Close programmatic MCP connections. */
  dispose: () => Promise<void>;
}

// ── Tool-name aliases (mirror core's TOOL_ALIASES for PascalCase input) ──

const TOOL_ALIASES: Record<string, string> = {
  task: 'agent',
  edit: 'update',
  'team-create': 'teamcreate',
  'team-message': 'sendmessage',
};

function normalizeToolName(name: string): string {
  const lower = name.toLowerCase();
  return TOOL_ALIASES[lower] ?? lower;
}

function toolAllowed(name: string, options: Options): boolean {
  const normalized = normalizeToolName(name);
  if (options.allowedTools && options.allowedTools.length > 0) {
    if (!options.allowedTools.map(normalizeToolName).includes(normalized)) return false;
  }
  if (options.disallowedTools && options.disallowedTools.length > 0) {
    if (options.disallowedTools.map(normalizeToolName).includes(normalized)) return false;
  }
  return true;
}

// ── Tool registry ──────────────────────────────────────────────────────

function registerPlugin(registry: ToolRegistry, plugin: ToolPlugin): void {
  if (plugin.isEnabled && !plugin.isEnabled()) return;
  const schema = plugin.schema as unknown as Record<string, unknown>;
  const inputSchema = schema.input_schema as Record<string, unknown>;
  const meta = schema._meta as { riskLevel?: string; isConcurrencySafe?: boolean } | undefined;
  const riskLevel =
    meta?.riskLevel === 'safe' ? RiskLevel.SAFE :
    meta?.riskLevel === 'destructive' ? RiskLevel.DESTRUCTIVE :
    RiskLevel.MUTATION;

  registry.register(
    {
      name: plugin.name,
      description: (schema.description as string) ?? plugin.name,
      input_schema: inputSchema,
      riskLevel,
      isConcurrencySafe: meta?.isConcurrencySafe ?? false,
    },
    async (input: Record<string, unknown>, ctx: ToolContext) => {
      try {
        const executorOptions = {
          cwd: ctx.cwd ?? process.cwd(),
          allowMutation: true,
          maxOutput: 50_000,
          bashTimeout: ctx.timeoutMs ?? 30_000,
          agentSpawn: ctx.agentSpawn,
          sessionId: ctx.sessionId,
          setPermissionMode: ctx.setPermissionMode,
          getPermissionMode: ctx.getPermissionMode,
          planModeState: ctx.planModeState,
          getCoreState: ctx.getCoreState,
          emitToolRequest: ctx.emitToolRequest,
          toolUseId: ctx.toolUseId,
          readFileTracker: ctx.readFileTracker,
        };
        const r = await plugin.executor(input, executorOptions);
        return { content: r.content, isError: r.isError, duration: r.duration, metadata: r.metadata };
      } catch (err) {
        return { content: `Tool error: ${(err as Error).message}`, isError: true };
      }
    },
  );
}

async function buildToolRegistry(options: Options, cwd: string): Promise<{ registry: ToolRegistry; mcpServerNames: string[]; cleanup: Array<() => Promise<void>> }> {
  const registry = new ToolRegistry();
  const mcpServerNames: string[] = [];
  const cleanup: Array<() => Promise<void>> = [];

  // 1. Built-in plugins
  for (const plugin of plugins) {
    if (!toolAllowed(plugin.name, options)) continue;
    registerPlugin(registry, plugin);
  }

  // 2. MCP: programmatic servers (options.mcpServers) take precedence.
  if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
    for (const [name, cfg] of Object.entries(options.mcpServers)) {
      const scoped = { ...cfg, scope: 'local' } as ScopedServerConfig;
      const conn = await connectToServer(name, scoped, cwd);
      if (conn.type === 'connected') {
        mcpServerNames.push(name);
        cleanup.push(conn.cleanup);
        const mcpPlugins = await discoverTools(conn);
        for (const p of mcpPlugins) {
          if (!toolAllowed(p.name, options)) continue;
          registerPlugin(registry, p);
        }
      } else if (conn.type === 'failed') {
        options.stderr?.(`[MCP] Failed to connect to "${name}": ${conn.error ?? 'unknown error'}\n`);
      }
    }
  } else {
    // 3. Disk-configured MCP servers (via McpManager)
    try {
      const manager = new McpManager(cwd);
      await manager.initialize();
      mcpServerNames.push(...manager.getConnectedServerNames());
      const mcpPlugins = [...manager.getToolPlugins(), ...manager.getResourcePlugins()];
      for (const p of mcpPlugins) {
        if (!toolAllowed(p.name, options)) continue;
        registerPlugin(registry, p);
      }
    } catch (err) {
      options.stderr?.(`[MCP] Initialization failed: ${(err as Error).message}\n`);
    }
  }

  return { registry, mcpServerNames, cleanup };
}

// ── System prompt ──────────────────────────────────────────────────────

function resolveSystemPrompt(sp: string | SystemPromptConfig | undefined): string | undefined {
  if (!sp) return undefined;
  if (typeof sp === 'string') return sp;
  if (sp.type === 'override') return sp.content;
  // 'preset' → use the engine's default system prompt (v1).
  return undefined;
}

// ── Bootstrap ──────────────────────────────────────────────────────────

/**
 * Build the shareable half of an engine: config/settings/model/cwd plus the
 * connection-heavy registries (tools incl. programmatic MCP, agents, and the
 * stateless system-prompt assembler). Reuse one template across many
 * `buildEngineFromTemplate` calls so concurrent queries don't each re-spawn MCP
 * connections.
 */
export async function buildEngineTemplate(options: Options = {}): Promise<EngineTemplate> {
  const cwd = options.cwd ?? process.cwd();
  const config = loadConfig();
  const model = options.model ?? config.model;
  const settings = loadSettings();

  const { registry, mcpServerNames, cleanup } = await buildToolRegistry(options, cwd);
  const systemPromptAssembler = new SystemPromptAssembler();
  const { registry: agentRegistry } = await buildAgentRegistry(cwd);

  return {
    config,
    model,
    settings,
    cwd,
    toolRegistry: registry,
    mcpServerNames,
    systemPromptAssembler,
    agentRegistry,
    dispose: async () => {
      await Promise.allSettled(cleanup.map((fn) => fn()));
    },
  };
}

/**
 * Assemble a full, independently-scheduled QueryEngine from a shared template.
 * The session, sub-agent registry, callModel and QueryEngine are all fresh per
 * call — the mutable per-query state — while the registries come from the
 * template. No global `setTaskListId` side effect here: the per-session
 * sessionId flows through the tool context instead.
 */
export async function buildEngineFromTemplate(tpl: EngineTemplate, options: Options = {}): Promise<BuiltEngine> {
  // Per-agent model binding: options.baseUrl/apiKey (injected by agentstation)
  // override the global ~/.coderix/settings.json endpoint/auth.
  const baseUrl = options.baseUrl ?? tpl.config.baseUrl;
  const apiKey = options.apiKey ?? tpl.config.apiKey;

  const callModel = createCallModel({ baseUrl, apiKey, proxy: tpl.config.proxy, maxTokens: tpl.config.maxTokens }, tpl.model);

  const sessionManager = new SessionManager();
  if (options.resume) {
    try {
      sessionManager.resume(options.resume);
    } catch {
      sessionManager.create({ cwd: tpl.cwd, model: tpl.model });
    }
  } else {
    sessionManager.create({ cwd: tpl.cwd, model: tpl.model });
  }

  const subAgentRegistry = new SubAgentRegistry();

  const engine = new QueryEngine({
    cwd: tpl.cwd,
    toolRegistry: tpl.toolRegistry,
    sessionManager,
    callModel,
    model: tpl.model,
    maxToolConcurrency: getMaxToolConcurrency(tpl.settings),
    subAgentRegistry,
    systemPromptAssembler: tpl.systemPromptAssembler,
    agentRegistry: tpl.agentRegistry,
    settings: tpl.settings,
    maxContext: tpl.config.maxContext || undefined,
    briefMode: tpl.config.briefMode,
    autoCompactEnabled: tpl.config.autoCompactEnabled,
    compactThreshold: tpl.config.compactThreshold,
    maxTurns: options.maxTurns,
    customSystemPrompt: resolveSystemPrompt(options.systemPrompt),
    appendSystemPrompt: options.appendSystemPrompt,
  });

  await engine.init();
  engine.setPermissionMode(toCorePermissionMode(options.permissionMode));

  return {
    engine,
    sessionManager,
    toolRegistry: tpl.toolRegistry,
    config: tpl.config,
    model: tpl.model,
    settings: tpl.settings,
    cwd: tpl.cwd,
    mcpServerNames: tpl.mcpServerNames,
    dispose: async () => {
      await engine.shutdown();
    },
  };
}

/**
 * One-shot convenience: build a fresh template + engine together, disposing
 * both on `dispose()`. Use `buildEngineTemplate` + `buildEngineFromTemplate`
 * directly when you need many engines to share a single template.
 */
export async function buildEngine(options: Options = {}): Promise<BuiltEngine> {
  const template = await buildEngineTemplate(options);
  const built = await buildEngineFromTemplate(template, options);
  return {
    ...built,
    dispose: async () => {
      await built.dispose();
      await template.dispose();
    },
  };
}
