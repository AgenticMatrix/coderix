/**
 * Standalone demo: MCP Resource Tools in action
 *
 * Starts an in-process MCP server with resources, connects, and exercises
 * ListMcpResources + ReadMcpResource with visible output.
 *
 * Run: node --import tsx tests/mcp/demo-mcp-resources.ts
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ServerCapabilities } from '@modelcontextprotocol/sdk/types.js';

import { discoverResources, readResource } from '../../packages/coderix-core/src/mcp/discovery.js';
import {
  createListMcpResourcesPlugin,
  createReadMcpResourcePlugin,
} from '../../packages/coderix-core/src/mcp/mcp-resource-tools.js';
import type { ConnectedServer, ServerResource } from '../../packages/coderix-core/src/mcp/types.js';

// ── Setup: Create an MCP Server with resources ───────────────────────────

console.log('=== Step 1: Starting in-process MCP server with resources ===\n');

const server = new McpServer({ name: 'demo-server', version: '1.0.0' });

server.registerResource(
  'Config File',
  'config://app/settings.json',
  {
    description: 'Application settings in JSON format',
    mimeType: 'application/json',
  },
  async () => ({
    contents: [{
      uri: 'config://app/settings.json',
      mimeType: 'application/json',
      text: JSON.stringify({ port: 3000, debug: true, database: { host: 'localhost', port: 5432 } }, null, 2),
    }],
  }),
);

server.registerResource(
  'User Database Schema',
  'db://schema/users',
  {
    description: 'Schema definition of the users table with column descriptions',
    mimeType: 'text/sql',
  },
  async () => ({
    contents: [{
      uri: 'db://schema/users',
      mimeType: 'text/sql',
      text: [
        'CREATE TABLE users (',
        '  id        SERIAL PRIMARY KEY,',
        '  name      TEXT NOT NULL,',
        '  email     TEXT UNIQUE NOT NULL,',
        '  created   TIMESTAMP DEFAULT NOW()',
        ');',
      ].join('\n'),
    }],
  }),
);

server.registerResource(
  'Deployment Log',
  'file:///var/log/deploy.log',
  {
    description: 'Recent deployment log (binary stream)',
    mimeType: 'application/octet-stream',
  },
  async () => ({
    contents: [{
      uri: 'file:///var/log/deploy.log',
      mimeType: 'application/octet-stream',
      blob: Buffer.from('mock-binary-deploy-log-v2').toString('base64'),
    }],
  }),
);

// Connect using in-memory transport
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'coderix', version: '0.1.0' }, { capabilities: { roots: {} } });
await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

const capabilities = client.getServerCapabilities() ?? {};
const connected: ConnectedServer = {
  name: 'demo-server',
  type: 'connected',
  client,
  capabilities: capabilities as ServerCapabilities,
  config: { command: 'demo', scope: 'local' as const },
  cleanup: async () => { await client.close(); },
};

// ── Step 2: Discover Resources ────────────────────────────────────────

console.log('=== Step 2: Discover Resources ===\n');

const resources: ServerResource[] = await discoverResources(connected);

for (const r of resources) {
  const parts = [`  📄 ${r.name}`, `     URI:  ${r.uri}`];
  if (r.description) parts.push(`     Desc: ${r.description}`);
  if (r.mimeType) parts.push(`     MIME: ${r.mimeType}`);
  console.log(parts.join('\n'));
}
console.log(`\n  Total: ${resources.length} resource(s)\n`);

// ── Step 3: ListMcpResources Tool ────────────────────────────────────

console.log('=== Step 3: ListMcpResources Tool Output ===\n');

const listMgr = {
  getConnection: () => undefined,
  getServerResources: () => [],
  getAllResources: () => resources,
} as any;

const listPlugin = createListMcpResourcesPlugin(listMgr);
const listResult = await listPlugin.executor({});
console.log(listResult.content);

// ── Step 4: ReadMcpResource Tool ─────────────────────────────────────

console.log('=== Step 4: ReadMcpResource Tool Output ===\n');

const readMgr = {
  getConnection: (name: string) => name === 'demo-server' ? connected : undefined,
} as any;

const readPlugin = createReadMcpResourcePlugin(readMgr);

// Read JSON config
{
  const result = await readPlugin.executor({ server: 'demo-server', uri: 'config://app/settings.json' });
  console.log(result.content);
}

// Read SQL schema
{
  const result = await readPlugin.executor({ server: 'demo-server', uri: 'db://schema/users' });
  console.log(result.content);
}

// Read binary log
{
  const result = await readPlugin.executor({ server: 'demo-server', uri: 'file:///var/log/deploy.log' });
  console.log(result.content);
}

// Try non-existent resource
{
  const result = await readPlugin.executor({ server: 'demo-server', uri: 'fake://missing' });
  console.log(`[Expected error] ${result.content}\n`);
}

// ── Cleanup ──────────────────────────────────────────────────────────

await client.close();
console.log('=== Demo complete ===');
