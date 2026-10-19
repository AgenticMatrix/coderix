#!/usr/bin/env node
/**
 * verify-officeharness-mcp — drive the bundled stdio MCP server directly.
 *
 * The MCP transport intentionally drops responses after stdin EOF, so this
 * keeps the pipe open until the workspace-info response arrives.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const PLUGIN =
  process.env.OFFICEHARNESS_PLUGIN_DIR ??
  path.join(HOME, 'Documents', 'apps', 'OfficeHarness', 'officeharness_plugins', 'office-harness');
const PROFILE =
  process.env.OFFICEHARNESS_PROFILE_DIR ?? path.join(HOME, '.coderix', 'officeharness', 'embedded');

function priorHostPid() {
  try {
    const metadata = JSON.parse(readFileSync(path.join(PROFILE, 'connection.json'), 'utf8'));
    if (typeof metadata.pid !== 'number') return null;
    process.kill(metadata.pid, 0);
    return metadata.pid;
  } catch {
    return null;
  }
}

const preExisting = priorHostPid();

const child = spawn(path.join(PLUGIN, 'runtime', 'bin', 'node'), [path.join(PLUGIN, 'host', 'mcp.cjs')], {
  env: {
    ...process.env,
    OFFICEHARNESS_MANAGED_HOST: '1',
    OFFICEHARNESS_CONNECTION_FILE: path.join(PROFILE, 'connection.json'),
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buffer = '';
const pending = new Map();
const results = new Map();

function send(message) {
  child.stdin.write(JSON.stringify(message) + '\n');
  return new Promise((resolve, reject) => {
    pending.set(message.id, { resolve, reject, message });
  });
}

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      results.set(message.id, message);
      waiter.resolve(message);
    }
  }
});

child.stderr.on('data', (chunk) => process.stderr.write(chunk));

function timeout(ms, label) {
  return new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error(`${label} timed out`)), ms).unref();
  });
}

async function main() {
  const init = await Promise.race([
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify', version: '1' } },
    }),
    timeout(30_000, 'initialize'),
  ]);
  const serverName = init.result?.serverInfo?.name;
  console.log(`${serverName === 'officeharness-v3' ? 'OK  ' : 'FAIL'} initialize (${serverName})`);

  const list = await Promise.race([
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    timeout(15_000, 'tools/list'),
  ]);
  const tools = list.result?.tools ?? [];
  console.log(`${tools.length === 68 ? 'OK  ' : 'FAIL'} tools/list (${tools.length} tools)`);

  const info = await Promise.race([
    send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'ppt_get_workspace_info', arguments: {} },
    }),
    timeout(30_000, 'workspace info'),
  ]);
  const text = info.result?.content?.find((item) => item.type === 'text')?.text;
  const workspace = text ? JSON.parse(text) : null;
  const ok = Boolean(workspace?.url?.startsWith('http://127.0.0.1:')) && workspace?.port > 0;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ppt_get_workspace_info (${workspace?.url}, editor_online=${workspace?.editor_online})`);

  if (serverName !== 'officeharness-v3' || tools.length !== 68 || !ok) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => {
    // Closing stdin lets the server release its client lease; if this test
    // started the host, stop it once the lease is gone. Do not unref this timer:
    // the process must stay alive long enough to actually clean up.
    child.stdin.end();
    setTimeout(() => {
      child.kill('SIGTERM');
      if (!preExisting) {
        const pid = priorHostPid();
        if (pid && pid !== preExisting) {
          try {
            process.kill(pid, 'SIGTERM');
          } catch {
            // already gone
          }
        }
      }
    }, 1200);
  });
