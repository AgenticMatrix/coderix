import { startProtocolGateway } from './packages/coderix-desktop/src/main/protocol-gateway/server.js';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

process.env.CONVERSION_PORT = '17841';

const settings = JSON.parse(readFileSync(join(homedir(), '.coderix', 'settings.json'), 'utf-8'));
const entry = settings.model_list.find((e: any) => (e.provider ?? '').toLowerCase() === 'astria');
const baseUrl: string = entry.base_url;
const apiKey: string = entry.auth_token_env;
const protocol = entry.protocol ?? (/\/v\d+/.test(baseUrl) ? 'openai' : 'anthropic');

console.log('=== claude CLI full-path test ===');
console.log('baseUrl:', baseUrl, '| protocol:', protocol, '| key set:', !!apiKey);

const gw = startProtocolGateway(() => ({ baseUrl, apiKey, protocol, maxTokens: entry.max_tokens }));
await new Promise<void>((r) => gw.once('listening', () => r()));

const gatewayBase = `http://127.0.0.1:17841/gw/Atria-Dawn-Preview`;
const claudeBin = join(homedir(), '.local', 'bin', 'claude');

console.log('gatewayBase:', gatewayBase);
console.log('claudeBin:', claudeBin);
console.log('--- spawning claude ---');

const child = spawn(
  claudeBin,
  ['-p', 'Reply with exactly the single word: pong', '--model', 'Atria-Dawn-Preview'],
  {
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: gatewayBase,
      ANTHROPIC_API_KEY: apiKey,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
    cwd: process.cwd(),
  },
);

let out = '';
let err = '';
child.stdout.on('data', (d) => { out += d; process.stdout.write('[stdout] ' + d); });
child.stderr.on('data', (d) => { err += d; process.stderr.write('[stderr] ' + d); });

const timer = setTimeout(() => {
  console.error('\n[timeout] killing claude after 90s');
  child.kill('SIGKILL');
}, 90000);

child.on('close', (code, signal) => {
  clearTimeout(timer);
  console.log('\n=== RESULT ===');
  console.log('exit code:', code, 'signal:', signal);
  console.log('stdout len:', out.length);
  console.log('stderr len:', err.length);
  gw.close();
  process.exit(code ?? 0);
});
