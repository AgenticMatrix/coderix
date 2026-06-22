/**
 * ACP E2E test — spawns `coder --acp`, connects via NDJSON, exercises protocol.
 *
 * Tests that do NOT require API credentials:
 *   1. Process starts and accepts connections
 *   2. Initialize handshake
 *   3. Graceful shutdown
 *
 * Tests requiring API keys (skipped when unavailable):
 *   4. Session create + prompt + streaming
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..');
const TSX_CLI = path.join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI_ENTRY = path.join(PROJECT_ROOT, 'src', 'cli', 'main.tsx');
const HAS_API_KEY = !!(
  process.env.ANTHROPIC_API_KEY ||
  process.env.OPENAI_API_KEY ||
  process.env.DEEPSEEK_API_KEY
);

describe('ACP Server E2E', () => {
  let proc: ChildProcess | null = null;
  let pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  let events: any[] = [];
  let nextId = 1;

  function rpc(method: string, params?: unknown): Promise<any> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      const req = { jsonrpc: '2.0', id, method, params };
      proc!.stdin!.write(JSON.stringify(req) + '\n');
      // Timeout after 15s
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`RPC timeout: ${method}`));
        }
      }, 15_000);
    });
  }

  beforeAll(async () => {
    proc = spawn(process.execPath, [TSX_CLI, CLI_ENTRY, '--acp'], {
      cwd: PROJECT_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    const rl = createInterface({ input: proc.stdout! });
    let buffer = '';

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('ACP process start timeout')), 10_000);

      rl.on('line', (line: string) => {
        buffer += line;
        try {
          const msg = JSON.parse(buffer);
          buffer = '';
          if ('id' in msg && msg.id !== undefined) {
            const p = pending.get(msg.id);
            if (p) {
              pending.delete(msg.id);
              if (msg.error) p.reject(new Error(msg.error.message ?? 'RPC error'));
              else p.resolve(msg.result);
            }
          } else if ('method' in msg) {
            events.push(msg);
          }
        } catch {
          // Partial JSON
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      // Process is started — resolve after a tick
      setTimeout(() => {
        clearTimeout(timeout);
        resolve();
      }, 500);
    });
  }, 15_000);

  afterAll(() => {
    if (proc) {
      proc.kill();
      proc = null;
    }
  });

  it('should start coder --acp process', () => {
    expect(proc).not.toBeNull();
    expect(proc!.pid).toBeGreaterThan(0);
    expect(proc!.exitCode).toBeNull(); // still running
  });

  it('should complete initialize handshake', async () => {
    const result = await rpc('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'e2e-test', version: '1.0.0' },
    });

    expect(result.protocolVersion).toBe(1);
    expect(result.agentCapabilities).toBeDefined();
    expect(result.agentInfo?.name).toBe('coderix');
  });

  // These tests require API credentials
  const describeApi = HAS_API_KEY ? describe : describe.skip;

  describeApi('with API credentials', () => {
    let sessionId: string;

    it('should create a new session', async () => {
      const result = await rpc('session/new', {
        cwd: PROJECT_ROOT,
        mcpServers: [],
      });
      expect(result.sessionId).toBeTruthy();
      sessionId = result.sessionId;
      expect(result.modes?.currentModeId).toBe('ask');
    });

    it('should stream a simple prompt', async () => {
      const promptPromise = rpc('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'Reply with just the word "OK"' }],
      });

      // Wait for result in 30s
      const result = await promptPromise;
      expect(result.stopReason).toBeDefined();

      // We should have received session/update notifications
      const updates = events.filter((e) => e.method === 'session/update');
      expect(updates.length).toBeGreaterThan(0);
    }, 30_000);

    it('should cancel an in-progress prompt', async () => {
      // Send a prompt that takes some time
      const promptPromise = rpc('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'Write a haiku about coding' }],
      });

      // Cancel after 500ms
      await new Promise((r) => setTimeout(r, 500));
      await rpc('session/cancel', { sessionId });

      const result = await promptPromise;
      expect(result.stopReason).toBe('cancelled');
    }, 30_000);
  });
});
