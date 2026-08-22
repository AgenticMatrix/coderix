/**
 * End-to-end example for the Coderix TypeScript SDK (`@coderix/sdk`).
 *
 * Run from the repo root (after `pnpm install` + `pnpm build`):
 *
 *   npx tsx examples/sdk-query.ts
 *
 * Mirrors claude-code-sdk's `query()` async generator.
 */

import { query, CoderixSDKClient } from '@coderix/sdk';

async function oneShot() {
  console.log('=== query() ===');
  for await (const msg of query({
    prompt: 'Reply with exactly: hello',
    options: { permissionMode: 'plan', maxTurns: 3, includePartialMessages: false },
  })) {
    switch (msg.type) {
      case 'system':
        console.log(`[system] ${msg.subtype} session=${msg.session_id}`);
        break;
      case 'assistant': {
        const content = typeof msg.message.content === 'string'
          ? msg.message.content
          : msg.message.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
        console.log(`[assistant] ${content}`);
        break;
      }
      case 'result':
        console.log(`[result] ${msg.subtype} turns=${msg.num_turns} cost=$${msg.total_cost_usd.toFixed(4)}`);
        console.log(`         ${msg.result}`);
        break;
      default:
        break;
    }
  }
}

async function client() {
  console.log('\n=== CoderixSDKClient ===');
  const c = new CoderixSDKClient({ permissionMode: 'plan' });
  await c.connect();
  try {
    for await (const msg of c.query({ prompt: 'Say hi in one word' })) {
      if (msg.type === 'result') {
        console.log(`[result] ${msg.subtype}: ${msg.result}`);
      }
    }
  } finally {
    await c.disconnect();
  }
}

async function main() {
  await oneShot();
  await client();
}

main().catch((err) => {
  console.error('Example failed:', err);
  process.exit(1);
});
