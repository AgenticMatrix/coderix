#!/usr/bin/env node
/**
 * Coderix — CLI Entry Point
 *
 * Flags: --help, --version, --model, --setup, --print, --gateway
 *        --desktop [--desktop-port <port>]
 *        --chrome-mcp [--chrome-mcp-port <port>]
 *        --computer-use-mcp
 * Dynamic imports keep TUI deps (react/ink) out of gateway/print modes.
 */

import { loadConfig, loadSettings, getMaxToolConcurrency } from './config.js';
import type { ToolDefinition, ToolContext, ToolExecutionResult, QueryMessage, StreamEvent } from '@coderix/core';

// ── CLI args ──────────────────────────────────────────────────────────

interface CliArgs {
  help: boolean;
  version: boolean;
  model?: string;
  setup: boolean;
  print?: string;
  query?: string;
  gateway: boolean;
  desktop: boolean;
  desktopPort?: number;
  acp: boolean;
  acpPort?: number;
  chromeMcp: boolean;
  chromeMcpPort?: number;
  computerUseMcp: boolean;
}

function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    help: false,
    version: false,
    setup: false,
    gateway: false,
    desktop: false,
    acp: false,
    chromeMcp: false,
    computerUseMcp: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case '--help': case '-h': args.help = true; break;
      case '--version': case '-V': args.version = true; break;
      case '--model': case '-m': args.model = argv[i + 1]; if (args.model && !args.model.startsWith('-')) i++; else args.model = ''; break;
      case '--setup': case 'setup': args.setup = true; break;
      case '--gateway': case '-g': args.gateway = true; break;
      case '--desktop': case '-d': args.desktop = true; break;
      case '--desktop-port': args.desktopPort = parseInt(argv[i + 1]!, 10); if (!isNaN(args.desktopPort)) i++; break;
      case '--acp': args.acp = true; break;
      case '--acp-port': args.acpPort = parseInt(argv[i + 1]!, 10); if (!isNaN(args.acpPort)) i++; break;
      case '--print': case '-p': args.print = argv[i + 1] ?? ''; if (args.print) i++; break;
      case '--chrome-mcp': args.chromeMcp = true; break;
      case '--chrome-mcp-port': args.chromeMcpPort = parseInt(argv[i + 1]!, 10); if (!isNaN(args.chromeMcpPort)) i++; break;
      case '--computer-use-mcp': args.computerUseMcp = true; break;
      default: if (!arg.startsWith('-') && !args.query) positional.push(arg); break;
    }
  }
  if (positional.length > 0) args.query = positional.join(' ');
  return args;
}

// ── Tool registry (shared) ──────────────────────────────────────────

async function buildToolRegistry(mcpPlugins?: any[]): Promise<any> {
  const { ToolRegistry } = await import('@coderix/core');
  const { plugins } = await import('@coderix/core');
  const { RiskLevel } = await import('@coderix/core');
  const registry = new ToolRegistry();

  // Collect all plugins: built-in + MCP
  const allPlugins = [...plugins, ...(mcpPlugins ?? [])];

  for (const plugin of allPlugins) {
    if (plugin.isEnabled && !plugin.isEnabled()) continue;
    const schema = plugin.schema as unknown as Record<string, unknown>;
    const inputSchema = schema.input_schema as Record<string, unknown>;
    const meta = schema._meta as { riskLevel?: string; isConcurrencySafe?: boolean } | undefined;
    const riskLevel = meta?.riskLevel === 'safe' ? RiskLevel.SAFE : meta?.riskLevel === 'destructive' ? RiskLevel.DESTRUCTIVE : RiskLevel.MUTATION;
    registry.register({ name: plugin.name, description: (schema.description as string) ?? plugin.name, input_schema: inputSchema, riskLevel, isConcurrencySafe: meta?.isConcurrencySafe ?? false },
      async (input: Record<string, unknown>, ctx: any) => {
        try {
          const r = await plugin.executor(input, {
            cwd: ctx.cwd ?? process.cwd(),
            allowMutation: true,
            maxOutput: 50_000,
            bashTimeout: ctx.timeoutMs ?? 30_000,
            agentSpawn: ctx.agentSpawn,
            getAppState: ctx.getAppState,
            setAppState: ctx.setAppState,
            setPermissionMode: ctx.setPermissionMode,
            getPermissionMode: ctx.getPermissionMode,
            planModeState: ctx.planModeState,
            readFileTracker: ctx.readFileTracker,
          });
          return { content: r.content, isError: r.isError, duration: r.duration, metadata: r.metadata };
        }
        catch (err) { return { content: `Tool error: ${(err as Error).message}`, isError: true }; }
      });
  }
  return registry;
}

// ── MCP initialization ─────────────────────────────────────────────────

async function initMcpAndGetPlugins(cwd: string): Promise<any[]> {
  try {
    const { McpManager } = await import('@coderix/core');
    const manager = new McpManager(cwd);
    await manager.initialize();
    const plugins = manager.getToolPlugins();
    const resourcePlugins = manager.getResourcePlugins();
    if (plugins.length > 0) {
      process.stderr.write(`[MCP] Loaded ${plugins.length} tool(s) from ${manager.getConnectedServerNames().length} server(s)\n`);
      const failed = manager.getFailedServerNames();
      if (failed.length > 0) {
        process.stderr.write(`[MCP] Warning: ${failed.length} server(s) failed to connect: ${failed.join(', ')}\n`);
      }
    }
    return [...plugins, ...resourcePlugins];
  } catch (err) {
    // MCP is optional — don't block startup on errors
    process.stderr.write(`[MCP] Initialization failed: ${(err as Error).message}\n`);
    return [];
  }
}

// ── Print mode ──────────────────────────────────────────────────────

async function runPrintMode(queryText: string): Promise<void> {
  let config; try { config = loadConfig(); } catch (err) { process.stderr.write(`Config error: ${(err as Error).message}\n`); process.exit(1); }
  const { createClient } = await import('../api/client.js');
  const { createCallModelFromClient } = await import('@coderix/core');
  const client = createClient(config); const callModel = createCallModelFromClient(client, config.model);
  const { SessionManager } = await import('@coderix/core');
  const sm = new SessionManager(); sm.create({ cwd: process.cwd(), model: config.model });
  const { setTaskListId } = await import('@coderix/core');
  setTaskListId(sm.getActive().id);
  const { SubAgentRegistry } = await import('@coderix/core');
  const { SystemPromptAssembler } = await import('@coderix/core');
  const { QueryEngine } = await import('@coderix/core');
  const { PermissionMode } = await import('@coderix/core');
  const { buildAgentRegistry } = await import('@coderix/core');
  const { registry: agentRegistry } = await buildAgentRegistry(process.cwd());
  const settings = loadSettings();
  const mcpPlugins = await initMcpAndGetPlugins(process.cwd());
  const engine = new QueryEngine({ cwd: process.cwd(), toolRegistry: await buildToolRegistry(mcpPlugins), sessionManager: sm, callModel, model: config.model, maxToolConcurrency: getMaxToolConcurrency(settings), subAgentRegistry: new SubAgentRegistry(), systemPromptAssembler: new SystemPromptAssembler(), agentRegistry, settings, briefMode: config.briefMode, autoCompactEnabled: config.autoCompactEnabled, compactThreshold: config.compactThreshold });
  await engine.init(); engine.setPermissionMode(PermissionMode.AUTO);
  let fullText = '';
  for await (const event of engine.submitMessage(queryText)) {
    if (event.type === 'message') {
      const msg = event.data as QueryMessage;
      if (msg.type === 'stream_event') { const se = msg.event as StreamEvent; if (se.type === 'content_block_delta' && se.delta?.type === 'text_delta') { fullText += se.delta.text!; process.stdout.write(se.delta.text!); } }
      else if (msg.type === 'assistant') { const blocks = msg.message?.content as any; if (blocks) for (const b of blocks) { if (b.type === 'text') { const t = b.text ?? b.content ?? ''; if (!fullText.includes(t)) { fullText += t; process.stdout.write(t); } } } }
    } else if (event.type === 'error') { process.stderr.write(`\n${(event.data as any)?.message ?? 'Error'}\n`); process.exit(1); }
  }
  if (fullText) process.stdout.write('\n'); process.exit(0);
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cliArgs = parseCliArgs(process.argv.slice(2));

  // ── MCP subcommand (before help/version to allow `coderix mcp --help`) ─
  if (process.argv[2] === 'mcp') {
    const { handleMcpCli } = await import('./mcp-cli.js');
    await handleMcpCli(process.argv.slice(3));
    return;
  }

  // ── Built-in MCP server modes (subprocess entry points) ────────────
  if (cliArgs.chromeMcp) {
    const { runChromeMcpServer } = await import('@coderix/core');
    await runChromeMcpServer(cliArgs.chromeMcpPort);
    return;
  }

  if (cliArgs.computerUseMcp) {
    if (process.platform !== 'darwin') {
      console.error('Error: --computer-use-mcp is only supported on macOS.');
      process.exit(1);
    }
    const { runComputerUseMcpServer } = await import('@coderix/core');
    await runComputerUseMcpServer();
    return;
  }

  if (cliArgs.help) { console.log(`Usage: coderix [options] [query]\n\nOptions:\n  --help, -h            Show help\n  --version, -V         Print version\n  --model, -m [name]    Select model\n  --setup               Setup wizard\n  --print, -p <query>   One-shot query\n  --gateway, -g         JSON-RPC gateway mode (stdin/stdout)\n  --desktop, -d         WebSocket gateway mode (for desktop app)\n  --desktop-port <port> WebSocket port for desktop mode (default 9754)\n  --chrome-mcp          Start Chrome MCP server (stdin/stdout)\n  --chrome-mcp-port <n> CDP port for Chrome (default 9222)\n  --computer-use-mcp    Start Computer Use MCP server (macOS)\n\nSubcommands:\n  mcp                   Manage MCP servers\n`); process.exit(0); }

  if (cliArgs.version) { const { readFileSync } = await import('node:fs'); const { join, dirname } = await import('node:path'); const { fileURLToPath } = await import('node:url'); const { detectShell } = await import('@coderix/core'); const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf-8')) as { version: string }; const shell = detectShell(); console.log(`coderix ${pkg.version}\nnode ${process.version}\n${process.platform} ${process.arch}\nshell ${shell.path} (${shell.type})`); process.exit(0); }

  if (cliArgs.model !== undefined || process.argv.includes('--model') || process.argv.includes('-m')) {
    const { handleModelFlag } = await import('./model-picker.js');
    const keep = setInterval(() => {}, 60000);
    try { await handleModelFlag(cliArgs.model || undefined); } finally { clearInterval(keep); }
    return;
  }

  if (cliArgs.setup || process.argv.includes('setup') || process.argv.includes('--setup')) {
    const { handleSetupFlag } = await import('./model-picker.js');
    const keep = setInterval(() => {}, 60000);
    try { await handleSetupFlag(); } finally { clearInterval(keep); }
  }

  const printQuery = cliArgs.print ?? cliArgs.query;
  if (printQuery) { await runPrintMode(printQuery); return; }

  // ── Gateway mode ──────────────────────────────────────────────
  if (cliArgs.gateway) { const { startGateway } = await import('../gateway/server.js'); await startGateway(); return; }

  // ── Desktop mode (WebSocket gateway for Tauri app) ────────────
  if (cliArgs.desktop) {
    const { startDesktopGateway } = await import('../gateway/desktop.js');
    const port = cliArgs.desktopPort ?? 9754;
    await startDesktopGateway({ port, cwd: process.cwd() });
    return;
  }

  if (cliArgs.acp) { const { startAcpServer } = await import('../acp/server.js'); await startAcpServer(cliArgs.acpPort); return; }

  // ── TUI mode ──────────────────────────────────────────────────
  let config; try { config = loadConfig(); } catch (err) { process.stderr.write(`Config error: ${(err as Error).message}\n`); process.exit(1); }
  const { createClient } = await import('../api/client.js');
  const { createCallModelFromClient } = await import('@coderix/core');
  const client = createClient(config); const callModel = createCallModelFromClient(client, config.model);
  const { SessionManager } = await import('@coderix/core');
  const sm = new SessionManager(); sm.create({ cwd: process.cwd(), model: config.model });
  const { setTaskListId } = await import('@coderix/core');
  setTaskListId(sm.getActive().id);

  // Clear stale team configs from previous sessions
  const { resetAllTeams } = await import('@coderix/core');
  await resetAllTeams();

  const { SubAgentRegistry } = await import('@coderix/core');
  const { SystemPromptAssembler } = await import('@coderix/core');
  const { QueryEngine } = await import('@coderix/core');
  const { buildAgentRegistry: buildAgentReg } = await import('@coderix/core');
  const subAgentRegistry = new SubAgentRegistry();
  const { setSubAgentRegistry } = await import('@coderix/core');
  setSubAgentRegistry(subAgentRegistry);
  const { registry: agentRegistry } = await buildAgentReg(process.cwd());
  const settings = loadSettings();
  const mcpPluginsTui = await initMcpAndGetPlugins(process.cwd());
  // ── Create EventBus for core→UI communication ─────────────────────
  const { createEventBus } = await import('@coderix/core');
  const eventBus = createEventBus();

  const engine = new QueryEngine({ cwd: process.cwd(), toolRegistry: await buildToolRegistry(mcpPluginsTui), sessionManager: sm, callModel, model: config.model, maxToolConcurrency: getMaxToolConcurrency(settings), subAgentRegistry, systemPromptAssembler: new SystemPromptAssembler(), agentRegistry, settings, eventBus, briefMode: config.briefMode, autoCompactEnabled: config.autoCompactEnabled, compactThreshold: config.compactThreshold });
  await engine.init();

  // ── Create unified AppState store ──────────────────────────────────
  const { createStore } = await import('@coderix/core');
  const { getDefaultAppState } = await import('../state/AppState.js');
  const { createInitialState } = await import('../tui/hooks/useChatReducer.js');
  const appStore = createStore(getDefaultAppState(
    config,
    createInitialState(config.model, config.inputPrice, config.outputPrice, config.cacheReadPrice),
    sm.getActive().id,
  ));

  // Wire SubAgentRegistry → EventBus → AppState (Phase 4)
  subAgentRegistry.setEmitter((req) => {
    eventBus.toolRequests.next(req);
  });

  // Wire EventBus → AppState sync for background tasks and agents
  const { createCoreEventBridge } = await import('../state/core-event-bridge.js');
  const bridge = createCoreEventBridge(eventBus, appStore);

  // ── Persistence bridge (Phase 3) ──────────────────────────────────
  const { attachPersistence } = await import('../state/persistence-bridge.js');
  attachPersistence(appStore);

  const { render } = await import('ink');
  const { App } = await import('../tui/components/App.js');
  const { AppStateProvider } = await import('../state/AppStateContext.js');
  const { waitUntilExit } = render(
    <AppStateProvider store={appStore}>
      <App config={config} engine={engine} store={appStore} sessionManager={sm} />
    </AppStateProvider>,
    { exitOnCtrlC: false, patchConsole: true },
  );
  await waitUntilExit();
}

main().catch((err) => { process.stderr.write(`Error: ${(err as Error).message}\n`); process.exit(1); });
