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
    // JSON-RPC response (has id)
    if ('id' in msg && msg.id !== undefined) {
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        if (msg.error) pending.reject(new Error(msg.error.message));
        else pending.resolve(msg.result);
      }
      return;
    }

    // JSON-RPC notification (has method, no id)
    if ('method' in msg) {
      this.handleNotification(msg.method, msg.params);
    }
  }

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
        } else if (kind === 'usage_update') {
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

      case 'session/request_permission': {
        const toolCall = params?.toolCall;
        this.send({
          type: 'approvalRequest',
          requestId: toolCall?.toolCallId ?? 'unknown',
          command: toolCall?.title ?? 'tool',
          description: toolCall?.rawInput ? JSON.stringify(toolCall.rawInput) : '',
        });
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

  handleApproval(requestId: string, allowed: boolean): void {
    // ACP uses request_permission response; we need to respond to the agent
    // For now, notify the permission outcome
    this.rpc('session/request_permission', {
      sessionId: this.activeSessionId,
      outcome: {
        outcome: allowed ? 'selected' : 'cancelled',
        ...(allowed ? { optionId: 'allow_once' } : {}),
      },
    }).catch(() => {});
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
