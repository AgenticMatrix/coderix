/**
 * ACP Server entry point — stdio mode via ndJsonStream.
 *
 * Launched via `coder --acp`.
 */

import { agent, ndJsonStream } from '@agentclientprotocol/sdk';
import { loadConfig } from '@coderix/core';
import { createAcpAgent } from './agent.js';

export async function startAcpServer(_port?: number): Promise<void> {
  const appConfig = await loadConfig();

  const app = agent({ name: 'coderix' });
  createAcpAgent(app, appConfig);

  // ndJsonStream from stdin/stdout
  const output = new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        process.stdout.write(chunk, (err) => (err ? reject(err) : resolve()));
      });
    },
  });

  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      process.stdin.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
      process.stdin.on('end', () => controller.close());
      process.stdin.on('error', (err) => controller.error(err));
    },
  });

  // Cast through any — Node.js stream/web types differ slightly from DOM types
  const stream = ndJsonStream(output as any, input as any);
  const conn = app.connect(stream as any);
  conn.signal?.addEventListener('abort', () => process.exit(0));
  await conn.closed;
}
