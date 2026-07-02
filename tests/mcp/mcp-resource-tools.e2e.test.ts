/**
 * E2E integration test for MCP Resource Tools (ListMcpResources + ReadMcpResource).
 *
 * Spins up an in-process MCP server with resources, connects via InMemoryTransport,
 * and exercises the full flow: discover → list → read.
 *
 * Run: npx vitest run tests/mcp/mcp-resource-tools.e2e.test.ts
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ServerCapabilities } from '@modelcontextprotocol/sdk/types.js';

import {
  createListMcpResourcesPlugin,
  createReadMcpResourcePlugin,
} from '../../packages/coderix-core/src/mcp/mcp-resource-tools.js';
import { discoverResources, readResource } from '../../packages/coderix-core/src/mcp/discovery.js';
import type { McpManager } from '../../packages/coderix-core/src/mcp/manager.js';
import type { ConnectedServer, ServerResource } from '../../packages/coderix-core/src/mcp/types.js';

// ── Shared state ─────────────────────────────────────────────────────────

let client: Client;
let connected: ConnectedServer;
let serverResources: ServerResource[];
const serverName = 'demo-server';

// ── Setup / TearDown ─────────────────────────────────────────────────────

beforeAll(async () => {
  // 1. Create an MCP server with resources registered
  const server = new McpServer(
    { name: 'demo-server', version: '1.0.0' },
  );

  // Register static resources
  server.registerResource(
    'Config File',
    'file:///app/config.json',
    {
      description: 'Application configuration in JSON format',
      mimeType: 'application/json',
    },
    async () => ({
      contents: [{
        uri: 'file:///app/config.json',
        mimeType: 'application/json',
        text: JSON.stringify({ port: 3000, debug: true, database: { host: 'localhost', port: 5432 } }, null, 2),
      }],
    }),
  );

  server.registerResource(
    'User Database Table',
    'pg://users/table',
    {
      description: 'Schema and sample of the users table',
      mimeType: 'text/sql',
    },
    async () => ({
      contents: [{
        uri: 'pg://users/table',
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
    'Error Log',
    'file:///var/log/error.log',
    {
      description: 'Recent application error log (binary sample)',
      mimeType: 'application/octet-stream',
    },
    async () => ({
      contents: [{
        uri: 'file:///var/log/error.log',
        mimeType: 'application/octet-stream',
        blob: Buffer.from('mock-binary-log-content').toString('base64'),
      }],
    }),
  );

  // 2. Create linked transports (client ↔ server)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  // 3. Connect both sides
  client = new Client(
    { name: 'coderix-test', version: '0.1.0' },
    { capabilities: { roots: {} } },
  );

  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  // 4. Build a ConnectedServer object (what McpManager would produce)
  const capabilities = client.getServerCapabilities() ?? {};
  connected = {
    name: serverName,
    type: 'connected',
    client,
    capabilities: capabilities as ServerCapabilities,
    config: { command: 'demo', scope: 'local' as const },
    cleanup: async () => { await client.close(); },
  };

  // 5. Discover resources
  serverResources = await discoverResources(connected);
});

afterAll(async () => {
  try { await client.close(); } catch { /* ignore */ }
});

// ── Console dump (for visual verification) ────────────────────────────────

function print(label: string, content: string) {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ${label}`);
  console.log('═'.repeat(70));
  console.log(content);
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('MCP Resource Tools E2E', () => {
  // ── Discovery ──────────────────────────────────────────────────────────

  describe('discoverResources()', () => {
    it('discovers all 3 registered resources', () => {
      expect(serverResources).toHaveLength(3);
      expect(serverResources.map((r) => r.name).sort()).toEqual([
        'Config File',
        'Error Log',
        'User Database Table',
      ]);
    });

    it('annotates each resource with server name', () => {
      for (const r of serverResources) {
        expect(r.server).toBe(serverName);
      }
    });

    it('includes resource metadata (uri, description, mimeType)', () => {
      const config = serverResources.find((r) => r.name === 'Config File')!;
      expect(config.uri).toBe('file:///app/config.json');
      expect(config.description).toBe('Application configuration in JSON format');
      expect(config.mimeType).toBe('application/json');

      const users = serverResources.find((r) => r.name === 'User Database Table')!;
      expect(users.uri).toBe('pg://users/table');
      expect(users.description).toContain('users table');
    });
  });

  // ── ListMcpResources via Plugin ─────────────────────────────────────────

  describe('ListMcpResources (plugin)', () => {
    it('lists all resources from the demo server', async () => {
      const manager = {
        getConnection: () => undefined,
        getServerResources: () => [],
        getAllResources: () => serverResources,
      } as unknown as McpManager;

      const plugin = createListMcpResourcesPlugin(manager);
      const result = await plugin.executor({});

      print('ListMcpResources (all)', result.content);

      expect(result.isError).toBe(false);
      expect(result.content).toContain('3 MCP resource(s) from 1 server(s)');
      expect(result.content).toContain('[demo-server]');
      expect(result.content).toContain('file:///app/config.json (application/json)');
      expect(result.content).toContain('Application configuration in JSON format');
      expect(result.content).toContain('pg://users/table (text/sql)');
      expect(result.content).toContain('file:///var/log/error.log (application/octet-stream)');
      expect(result.metadata!.count).toBe(3);
      expect(result.metadata!.serverCount).toBe(1);
    });

    it('filters by server name', async () => {
      const manager = {
        getConnection: (name: string) => name === serverName ? connected : undefined,
        getServerResources: (name: string) => name === serverName ? serverResources : [],
        getAllResources: () => serverResources,
      } as unknown as McpManager;

      const plugin = createListMcpResourcesPlugin(manager);
      const result = await plugin.executor({ server: serverName });

      print('ListMcpResources (filtered)', result.content);

      expect(result.isError).toBe(false);
      expect(result.content).toContain('3 MCP resource(s) from 1 server(s)');
      expect(result.metadata!.count).toBe(3);
    });
  });

  // ── ReadMcpResource via Plugin ──────────────────────────────────────────

  describe('ReadMcpResource (plugin)', () => {
    it('reads JSON text resource', async () => {
      const manager = {
        getConnection: (name: string) => name === serverName ? connected : undefined,
      } as unknown as McpManager;

      const plugin = createReadMcpResourcePlugin(manager);
      const result = await plugin.executor({
        server: serverName,
        uri: 'file:///app/config.json',
      });

      print('ReadMcpResource (JSON)', result.content);

      expect(result.isError).toBe(false);
      expect(result.content).toContain('=== Resource: file:///app/config.json ===');
      expect(result.content).toContain('Server: demo-server');
      expect(result.content).toContain('MIME type: application/json');
      expect(result.content).toContain('"port": 3000');
      expect(result.content).toContain('"database"');
      expect(result.content).toContain('=== End of resource ===');
      expect(result.metadata!.server).toBe(serverName);
      expect(result.metadata!.uri).toBe('file:///app/config.json');
      expect(result.metadata!.contentCount).toBe(1);
    });

    it('reads SQL text resource', async () => {
      const manager = {
        getConnection: (name: string) => name === serverName ? connected : undefined,
      } as unknown as McpManager;

      const plugin = createReadMcpResourcePlugin(manager);
      const result = await plugin.executor({
        server: serverName,
        uri: 'pg://users/table',
      });

      print('ReadMcpResource (SQL)', result.content);

      expect(result.isError).toBe(false);
      expect(result.content).toContain('CREATE TABLE users');
      expect(result.content).toContain('SERIAL PRIMARY KEY');
      expect(result.content).toContain('MIME type: text/sql');
    });

    it('reads blob (binary) resource', async () => {
      const manager = {
        getConnection: (name: string) => name === serverName ? connected : undefined,
      } as unknown as McpManager;

      const plugin = createReadMcpResourcePlugin(manager);
      const result = await plugin.executor({
        server: serverName,
        uri: 'file:///var/log/error.log',
      });

      print('ReadMcpResource (Blob)', result.content);

      expect(result.isError).toBe(false);
      expect(result.content).toContain('(binary)');
      expect(result.content).toContain('[Binary data: base64-encoded blob');
      expect(result.metadata!.mimeType).toBe('application/octet-stream');
    });

    it('returns error for non-existent resource URI', async () => {
      const manager = {
        getConnection: (name: string) => name === serverName ? connected : undefined,
      } as unknown as McpManager;

      const plugin = createReadMcpResourcePlugin(manager);
      const result = await plugin.executor({
        server: serverName,
        uri: 'file:///does/not/exist.txt',
      });

      // The server should return an error for unknown resources
      expect(result.isError).toBe(true);
      expect(result.content).toContain('Failed to read resource');
    });
  });

  // ── Direct readResource (discovery.ts) ──────────────────────────────────

  describe('readResource() directly', () => {
    it('returns structured content for valid URI', async () => {
      const result = await readResource(connected, 'file:///app/config.json');
      expect(result).not.toBeNull();
      expect(result!.contents).toBeDefined();
    });

    it('returns null for unknown URI', async () => {
      const result = await readResource(connected, 'file:///nope');
      expect(result).toBeNull();
    });
  });
});
