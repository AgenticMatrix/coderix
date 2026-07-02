/**
 * EngineHost — Direct QueryEngine integration (Phase 5)
 *
 * Replaces the sidecar subprocess model (VSCodeGatewayClient / AcpClient)
 * with a direct import of @coderix/core.  The QueryEngine runs in-process
 * inside the VS Code extension host, eliminating:
 *   - JSON-RPC serialization overhead
 *   - Subprocess management
 *   - Stdio line-buffer parsing
 *
 * Messages are mapped through the existing bridge layer:
 *   QueryEngineEvent → bridgeQueryToGateway() → gatewayToWebview()
 * so the webview protocol remains unchanged.
 */

import type { WebviewOutboundMessage } from '../types/webviewProtocol';
import { bridgeQueryToGateway, createBridgeState, resolveApproval } from '../bridge/index.js';
import type { BridgeState } from '../bridge/index.js';
import { gatewayToWebview } from '../gateway/gatewayToWebview';
import type { GatewayEvent } from '../bridge/events.js';

type MessageSender = (msg: WebviewOutboundMessage) => void;

export class EngineHost {
  private send: MessageSender;
  private engine: any = null;
  private sessionManager: any = null;
  private sessionId = '';
  private bridgeState: BridgeState;
  private model = '';

  constructor(send: MessageSender) {
    this.send = send;
    this.bridgeState = createBridgeState('');
  }

  private sendGatewayEvent(ev: GatewayEvent): void {
    for (const wm of gatewayToWebview(ev, this.sessionId)) {
      this.send(wm);
    }
  }

  private async ensureEngine(): Promise<void> {
    if (this.engine) return;

    const { workspace } = await import('vscode');
    const cwd = workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const config = workspace.getConfiguration('coder');

    // ── Load @coderix/core dynamically ──────────────────────────────
    const {
      QueryEngine,
      SessionManager,
      ToolRegistry,
      SystemPromptAssembler,
      SubAgentRegistry,
      PermissionMode,
      loadConfig,
      loadSettings,
      getMaxToolConcurrency,
      plugins,
      buildAgentRegistry,
    } = await import('@coderix/core');

    // ── API client & callModel ──────────────────────────────────────
    const appConfig = loadConfig();
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({
      baseURL: appConfig.baseUrl,
      apiKey: appConfig.apiKey,
    });
    const { createCallModelFromClient } = await import('@coderix/core');
    const callModel = createCallModelFromClient(
      client,
      config.get<string>('model') || appConfig.model,
    );

    // ── Session manager ─────────────────────────────────────────────
    this.sessionManager = new SessionManager();
    const session = this.sessionManager.create({
      cwd,
      model: config.get<string>('model') || appConfig.model,
    });
    this.sessionId = session.id;
    this.model = session.model;

    const { setTaskListId } = await import('@coderix/core');
    setTaskListId(session.id);

    // ── Tool registry ───────────────────────────────────────────────
    const { McpManager } = await import('@coderix/core');
    let mcpPlugins: any[] = [];
    try {
      const mcpManager = new McpManager(cwd);
      await mcpManager.initialize();
      mcpPlugins = [
        ...mcpManager.getToolPlugins(),
        ...mcpManager.getResourcePlugins(),
      ];
    } catch {
      // MCP is optional — don't block startup
    }

    const { RiskLevel } = await import('@coderix/core');
    const toolRegistry = new ToolRegistry();
    const allPlugins = [...plugins, ...mcpPlugins];

    for (const plugin of allPlugins) {
      const schema = plugin.schema as unknown as Record<string, unknown>;
      const inputSchema = schema.input_schema as Record<string, unknown>;
      const meta = schema._meta as { riskLevel?: string; isConcurrencySafe?: boolean } | undefined;
      const riskLevel =
        meta?.riskLevel === 'safe'
          ? RiskLevel.SAFE
          : meta?.riskLevel === 'destructive'
            ? RiskLevel.DESTRUCTIVE
            : RiskLevel.MUTATION;

      toolRegistry.register(
        {
          name: plugin.name,
          description: (schema.description as string) ?? plugin.name,
          input_schema: inputSchema,
          riskLevel,
          isConcurrencySafe: meta?.isConcurrencySafe ?? false,
        },
        async (input: Record<string, unknown>, ctx: any) => {
          try {
            const r = await plugin.executor(input, {
              cwd: ctx.cwd ?? cwd,
              allowMutation: true,
              maxOutput: 50_000,
              bashTimeout: ctx.timeoutMs ?? 30_000,
              agentSpawn: ctx.agentSpawn,
              sessionId: this.sessionId,
              setPermissionMode: ctx.setPermissionMode,
              getCoreState: ctx.getCoreState,
              emitToolRequest: ctx.emitToolRequest,
            });
            return { content: r.content, isError: r.isError, duration: r.duration, metadata: r.metadata };
          } catch (err) {
            return { content: `Tool error: ${(err as Error).message}`, isError: true };
          }
        },
      );
    }

    // ── Agents ──────────────────────────────────────────────────────
    const subAgentRegistry = new SubAgentRegistry();
    const { setSubAgentRegistry } = await import('@coderix/core');
    setSubAgentRegistry(subAgentRegistry);

    const { registry: agentRegistry } = await buildAgentRegistry(cwd);

    // ── Settings ────────────────────────────────────────────────────
    const settings = loadSettings();

    // ── Create engine ───────────────────────────────────────────────
    this.engine = new QueryEngine({
      cwd,
      toolRegistry,
      sessionManager: this.sessionManager,
      callModel,
      model: this.model,
      maxToolConcurrency: getMaxToolConcurrency(settings),
      subAgentRegistry,
      systemPromptAssembler: new SystemPromptAssembler(),
      agentRegistry,
      settings,
    });

    await this.engine.init();

    // Set initial permission mode from VS Code config
    const permMode = config.get<string>('permissionMode') ?? 'ask';
    this.engine.setPermissionMode(
      permMode === 'auto'
        ? PermissionMode.AUTO
        : permMode === 'plan'
          ? PermissionMode.PLAN
          : PermissionMode.ASK,
    );

    // Send ready status
    this.send({ type: 'statusUpdate', status: 'ready', message: `Ready — ${this.model}`, sessionId: this.sessionId });
    this.send({
      type: 'configUpdate',
      config: { model: this.model, provider: appConfig.provider ?? '', permissionMode: permMode as 'plan' | 'ask' | 'auto' },
    });
  }

  async submitPrompt(text: string): Promise<void> {
    try {
      await this.ensureEngine();
    } catch (err: any) {
      this.send({ type: 'errorMessage', message: `Engine init failed: ${err.message}` });
      return;
    }

    this.bridgeState = createBridgeState(this.sessionId);
    this.bridgeState.model = this.model;

    // Update session title from first message
    const title = text.length > 50 ? text.slice(0, 50) + '...' : text;
    this.send({ type: 'sessionSwitched', sessionId: this.sessionId, title });

    try {
      for await (const event of this.engine.submitMessage(text)) {
        switch (event.type) {
          case 'message': {
            const msg = event.data as any;
            // Route through existing bridge to produce GatewayEvent[]
            const gatewayEvents = bridgeQueryToGateway(msg, this.bridgeState);
            for (const ge of gatewayEvents) {
              this.sendGatewayEvent(ge);
            }
            break;
          }
          case 'done': {
            const data = event.data as any;
            if (data?.sessionId) {
              this.sessionId = data.sessionId;
            }
            break;
          }
          case 'error': {
            const data = event.data as any;
            this.send({ type: 'errorMessage', message: data?.message ?? 'Unknown error' });
            this.send({ type: 'statusUpdate', status: 'error', message: data?.message ?? 'Error', sessionId: this.sessionId });
            break;
          }
        }
      }

      this.send({ type: 'statusUpdate', status: 'ready', sessionId: this.sessionId });
    } catch (err: any) {
      this.send({ type: 'errorMessage', message: err.message || String(err) });
      this.send({ type: 'statusUpdate', status: 'error', message: 'Error', sessionId: this.sessionId });
    }
  }

  async interrupt(): Promise<void> {
    try {
      this.engine?.interrupt();
    } catch {
      // best-effort
    }
  }

  async createSession(_silent?: boolean): Promise<void> {
    await this.ensureEngine();
    const session = this.sessionManager?.create({
      cwd: this.engine?.config?.cwd ?? process.cwd(),
      model: this.model,
    });
    if (session) {
      this.sessionId = session.id;
      this.send({ type: 'sessionHistory', messages: [], sessionId: session.id });
      this.send({ type: 'sessionSwitched', sessionId: session.id, title: session.title || 'Untitled' });
      this.listSessions();
    }
  }

  async resumeSession(id: string): Promise<void> {
    await this.ensureEngine();
    try {
      const session = this.sessionManager?.resume(id);
      if (session) {
        this.sessionId = id;
        const messages = (session.messages ?? []).map((m: any) => ({
          role: m.role,
          text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        }));
        this.send({ type: 'sessionHistory', messages, sessionId: id });
        this.send({ type: 'sessionSwitched', sessionId: id, title: session.title || 'Untitled' });
        this.send({ type: 'statusUpdate', status: 'ready', message: 'Session resumed', sessionId: id });
      }
    } catch (err: any) {
      this.send({ type: 'errorMessage', message: err.message });
    }
  }

  listSessions(): void {
    try {
      const sessions = this.sessionManager?.list() ?? [];
      this.send({
        type: 'sessionList',
        sessions: sessions.map((s: any) => ({
          id: s.id,
          title: s.title,
          messageCount: s.turnCount ?? s.messageCount,
          startedAt: s.createdAt ?? s.updatedAt,
        })),
      });
    } catch {
      // best-effort
    }
  }

  handleApproval(requestId: string, allowed: boolean): void {
    const toolName = resolveApproval(this.bridgeState, requestId, allowed);
    if (toolName) {
      this.sendGatewayEvent({
        type: 'status.update',
        payload: { text: `${allowed ? 'Approved' : 'Denied'} ${toolName}` },
        session_id: this.sessionId,
      } as GatewayEvent);
    }
  }

  dispose(): void {
    this.engine = null;
    this.sessionManager = null;
  }
}
