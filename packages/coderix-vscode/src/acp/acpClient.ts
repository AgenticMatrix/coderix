/**
 * acpClient.ts — VS Code ACP Client
 *
 * Replaces vsCodeGateway.ts with standard ACP (Agent Client Protocol)
 * over stdio. Spawns `coder --acp` and communicates via JSON-RPC 2.0.
 * No custom protocol — standard session/update, session/prompt,
 * session/request_permission messages.
 */

import { spawn, ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { WebviewOutboundMessage } from '../types/webviewProtocol';

type MessageSender = (msg: WebviewOutboundMessage) => void;

// ---------------------------------------------------------------------------
// Minimal ACP JSON-RPC 2.0 message types
// ---------------------------------------------------------------------------

interface AcpRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

interface AcpResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface AcpNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

type AcpMessage = AcpResponse | AcpNotification;

// ---------------------------------------------------------------------------
// AcpClient — persistent ACP connection to `coder --acp`
// ---------------------------------------------------------------------------

export class AcpClient {
  private send: MessageSender;
  private proc: ChildProcess | null = null;
  private rl: ReturnType<typeof createInterface> | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private activeSessionId = '';
  private model = '';
  private initialized = false;
  private currentMessageId = '';
  private accumulatedText = '';
  private titleSent = false;

  private readyPromise: Promise<void>;

  constructor(send: MessageSender) {
    this.send = send;
    this.readyPromise = this.startProcess();
  }

  // -----------------------------------------------------------------------
  // Process management
  // -----------------------------------------------------------------------

  private async startProcess(): Promise<void> {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', '..');
    const tsxCli = path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const cliEntry = path.join(projectRoot, 'src', 'cli', 'main.tsx');
    const isDev = existsSync(tsxCli) && existsSync(cliEntry);

    const cmd = process.env.CODER_BIN
      ? process.env.CODER_BIN
      : isDev ? process.execPath : 'coder';
    const args = process.env.CODER_BIN
      ? ['--acp']
      : isDev ? [tsxCli, cliEntry, '--acp'] : ['--acp'];

    this.proc = spawn(cmd, args, {
      cwd: projectRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    this.rl = createInterface({ input: this.proc.stdout! });

    let buffer = '';
    this.rl.on('line', (line: string) => {
      buffer += line;
      try {
        const msg: AcpMessage = JSON.parse(buffer);
        buffer = '';
        this.handleMessage(msg);
      } catch {
        // Partial JSON, accumulate
      }
    });

    this.proc!.stderr!.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (text) {
        this.send({ type: 'errorMessage', message: `[coder] ${text}` });
      }
    });

    this.proc!.on('error', (err) => {
      this.send({ type: 'errorMessage', message: `Failed to start coder: ${err.message}` });
      this.send({ type: 'statusUpdate', status: 'error', message: 'CLI not found', sessionId: '' });
    });

    this.proc!.once('exit', (code) => {
      if (code !== 0 && code !== null) {
        this.send({ type: 'errorMessage', message: `Coder exited with code ${code}` });
      }
    });

    // ACP protocol: client MUST send initialize before any other requests
    try {
      const result = await this.rpc('initialize', {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'vscode-coder', version: '0.1.0' },
      });
      this.initialized = true;
      this.model = (result as any)?.agentInfo?.name ?? 'coderix';
      this.send({ type: 'configUpdate', config: { model: this.model, provider: '', permissionMode: 'ask' } });
      this.send({ type: 'statusUpdate', status: 'ready', message: `Ready`, sessionId: '' });
    } catch (err: any) {
      this.send({ type: 'errorMessage', message: `ACP init failed: ${err.message}` });
      this.send({ type: 'statusUpdate', status: 'error', message: `ACP init failed: ${err.message}`, sessionId: '' });
      throw err;
    }
  }

  // -----------------------------------------------------------------------
  // Message handling
  // -----------------------------------------------------------------------

  private handleMessage(msg: AcpMessage): void {
    const hasId = 'id' in msg && msg.id !== undefined;
    const hasMethod = 'method' in msg && msg.method !== undefined;

    if (hasId && hasMethod) {
      // JSON-RPC request from server (e.g., session/request_permission)
      const req = msg as unknown as { id: number; method: string; params: any };
      this.handleRequest(req.id, req.method, req.params);
      return;
    }

    if (hasId) {
      // JSON-RPC response to our request
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        if (msg.error) pending.reject(new Error(msg.error.message));
        else pending.resolve(msg.result);
      }
      return;
    }

    // JSON-RPC notification (has method, no id)
    if (hasMethod) {
      this.handleNotification(msg.method, msg.params);
    }
  }

  private handleRequest(id: number, method: string, params: any): void {
    switch (method) {
      case 'session/request_permission': {
        const perm = params as any;
        this.send({
          type: 'approvalRequest',
          requestId: String(id),
          command: perm?.toolCall?.name ?? 'tool',
          description: perm?.toolCall?.input
            ? JSON.stringify(perm.toolCall.input).slice(0, 200)
            : 'Requesting permission',
        });
        // Store the id so handleApproval can send the response
        this.pendingApprovalId = id;
        break;
      }
      default:
        break;
    }
  }

  private pendingApprovalId: number | null = null;

  private handleNotification(method: string, params: any): void {
    const sid = params?.sessionId ?? this.activeSessionId;

    switch (method) {
      case 'session/update': {
        const update = params?.update;
        if (!update) return;
        const kind = update.sessionUpdate;
        if (kind === 'agent_message_chunk') {
          const text = update.content?.text ?? '';
          const msgId = update.messageId ?? '';
          // Track message boundaries: new messageId = new assistant message
          if (msgId && msgId !== this.currentMessageId) {
            this.currentMessageId = msgId;
            this.accumulatedText = text;
          } else {
            this.accumulatedText += text;
          }
          if (text) {
            this.send({ type: 'messageDelta', text, sessionId: sid });
          }
        } else if (kind === 'tool_call') {
          this.send({
            type: 'toolStart',
            toolId: update.toolCallId,
            name: update.title ?? 'tool',
            args: update.rawInput ? JSON.stringify(update.rawInput) : undefined,
          });
          this.send({ type: 'statusUpdate', status: 'running_tool', message: `Running ${update.title ?? 'tool'}...`, sessionId: sid });
        } else if (kind === 'tool_call_update') {
          const status: 'completed' | 'error' = update.status === 'failed' ? 'error' : 'completed';
          const resultText = update.rawOutput
            ? (typeof update.rawOutput === 'string' ? update.rawOutput : JSON.stringify(update.rawOutput))
            : undefined;
          this.send({
            type: 'toolComplete',
            toolId: update.toolCallId,
            name: update.title ?? 'tool',
            durationMs: 0,
            error: status === 'error' ? (resultText ?? 'Tool failed') : undefined,
            resultText,
          });
        } else if (kind === 'agent_thought_chunk') {
          const thoughtText = update.content?.text ?? '';
          if (thoughtText) {
            this.send({ type: 'thinkingDelta', text: thoughtText, sessionId: sid });
          }
        } else if (kind === 'plan' || kind === 'plan_update') {
          // Forward plan entries as status update with structured text
          if (update.entries) {
            const entries = update.entries as Array<{ id: string; content: string; status: string }>;
            const planText = entries
              .map((e) => {
                const icon = e.status === 'completed' ? '[x]' : e.status === 'in_progress' ? '[*]' : '[ ]';
                return `${icon} ${e.content}`;
              })
              .join('\n');
            this.send({ type: 'statusUpdate', status: 'ready', message: `Tasks:\n${planText}`, sessionId: sid });
          }
        } else if (kind === 'usage_update') {
          if (update.used || update.size) {
            this.send({
              type: 'usageUpdate',
              usage: {
                calls: 1,
                input: 0,
                output: 0,
                cache: 0,
                total: update.used ?? 0,
                cost_usd: update.cost,
              },
              contextWindow: update.size,
              sessionId: sid,
            });
          }
          this.send({
            type: 'configUpdate',
            config: {
              model: this.model,
              provider: '',
              permissionMode: 'ask',
            },
          });
        }
        break;
      }

      default:
        break;
    }
  }

  // -----------------------------------------------------------------------
  // JSON-RPC helper
  // -----------------------------------------------------------------------

  private rpc(method: string, params?: unknown): Promise<unknown> {
    if (!this.proc?.stdin) return Promise.reject(new Error('Not connected'));
    const id = this.nextId++;
    const req: AcpRequest = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc!.stdin!.write(JSON.stringify(req) + '\n');
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('RPC timeout'));
        }
      }, 300_000);
    });
  }

  // -----------------------------------------------------------------------
  // Public API (matches VSCodeGatewayClient interface)
  // -----------------------------------------------------------------------

  async submitPrompt(text: string): Promise<void> {
    // Wait for initialize handshake to complete
    await this.readyPromise;

    // Ensure we have an active session (silent: don't switch UI)
    if (!this.activeSessionId) {
      await this.createSession(true);
    }

    const sid = this.activeSessionId;

    try {
      const result = await this.rpc('session/prompt', {
        sessionId: sid,
        prompt: [{ type: 'text', text }],
      });
      this.send({ type: 'messageComplete', text: this.accumulatedText, sessionId: sid });
      this.currentMessageId = '';
      this.accumulatedText = '';
      // Set session title from first user input
      if (!this.titleSent) {
        this.titleSent = true;
        const title = text.length > 50 ? text.slice(0, 50).replace(/[\r\n]+/g, ' ') + '...' : text.replace(/[\r\n]+/g, ' ');
        this.send({ type: 'sessionSwitched', sessionId: sid, title });
      }
      this.send({ type: 'statusUpdate', status: 'ready', message: 'Ready', sessionId: sid });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.send({ type: 'errorMessage', message: `[prompt] ${message}` });
      this.send({ type: 'statusUpdate', status: 'error', message: message, sessionId: sid });
    }
  }

  async interrupt(): Promise<void> {
    if (!this.activeSessionId) return;
    try {
      await this.rpc('session/cancel', { sessionId: this.activeSessionId });
    } catch {}
  }

  async createSession(silent = false): Promise<void> {
    try {
      const result = await this.rpc('session/new', {
        cwd: process.cwd(),
        mcpServers: [],
      });
      this.activeSessionId = (result as any)?.sessionId ?? '';
      this.titleSent = false;
      const metaModel = (result as any)?._meta?.model;
      if (metaModel) {
        this.model = metaModel;
        this.send({ type: 'configUpdate', config: { model: metaModel, provider: '', permissionMode: 'ask' } });
      }
      if (!silent) {
        this.send({ type: 'sessionHistory', messages: [], sessionId: this.activeSessionId });
        this.send({ type: 'sessionSwitched', sessionId: this.activeSessionId, title: 'New Session' });
      }
      this.listSessions();
    } catch (err: any) {
      const msg = `createSession failed: ${err.message}`;
      this.send({ type: 'errorMessage', message: msg });
      this.send({ type: 'statusUpdate', status: 'error', message: msg, sessionId: '' });
    }
  }

  async resumeSession(id: string): Promise<void> {
    try {
      this.activeSessionId = id;
      this.titleSent = true;
      const result = await this.rpc('session/resume', { sessionId: id, cwd: process.cwd() });
      // Send history if available in _meta
      const messages = (result as any)?._meta?.messages ?? [];
      if (messages.length > 0) {
        this.send({ type: 'sessionHistory', messages, sessionId: id });
      }
      const title = (result as any)?._meta?.title ?? 'Session';
      this.send({ type: 'sessionSwitched', sessionId: id, title });
      this.send({ type: 'statusUpdate', status: 'ready', message: 'Session resumed', sessionId: id });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.send({ type: 'errorMessage', message });
    }
  }

  listSessions(): void {
    this.rpc('session/list', {}).then((result) => {
      const sessions = (result as any)?.sessions ?? [];
      this.send({
        type: 'sessionList',
        sessions: sessions.map((s: any) => ({
          id: s.sessionId,
          title: s.title ?? 'Untitled',
          messageCount: s._meta?.turnCount ?? s.turnCount ?? 0,
          startedAt: s.updatedAt ? new Date(s.updatedAt).getTime() : Date.now(),
        })),
      });
    }).catch(() => {});
  }

  handleApproval(_requestId: string, allowed: boolean): void {
    // Respond to the server's session/request_permission request
    if (this.pendingApprovalId !== null && this.proc) {
      const response = {
        jsonrpc: '2.0',
        id: this.pendingApprovalId,
        result: { allowed },
      };
      this.proc.stdin?.write(JSON.stringify(response) + '\n');
      this.pendingApprovalId = null;
    }
  }

  setPermissionMode(mode: 'plan' | 'ask' | 'auto'): void {
    this.rpc('session/set_mode', { mode }).catch(() => {});
  }

  dispose(): void {
    if (this.proc) {
      try {
        if (this.activeSessionId) {
          this.proc.stdin?.write(JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/close',
            params: { sessionId: this.activeSessionId },
          }) + '\n');
        }
      } catch {}
      this.proc.kill();
      this.proc = null;
    }
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }
}
