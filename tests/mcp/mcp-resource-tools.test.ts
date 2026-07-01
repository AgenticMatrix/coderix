import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { McpManager } from '../../src/mcp/manager.js';
import type { ServerResource, ServerConnection } from '../../src/mcp/types.js';

// Mock readResource before importing the module under test
vi.mock('../../src/mcp/discovery.js', () => ({
  readResource: vi.fn(),
}));

const { readResource } = await import('../../src/mcp/discovery.js');
const mockReadResource = vi.mocked(readResource);

import {
  createListMcpResourcesPlugin,
  createReadMcpResourcePlugin,
} from '../../src/mcp/mcp-resource-tools.js';

// ── Helpers ──────────────────────────────────────────────────────────────

function makeConnectedServer(name: string): ServerConnection {
  return {
    name,
    type: 'connected',
    client: {} as any,
    capabilities: { resources: {} },
    config: { command: `cmd-${name}`, scope: 'local' },
    cleanup: async () => {},
  };
}

function makeFailedServer(name: string): ServerConnection {
  return {
    name,
    type: 'failed',
    config: { command: `cmd-${name}`, scope: 'local' },
    error: 'boom',
  };
}

function makeResource(overrides: Partial<ServerResource> = {}): ServerResource {
  return {
    server: 'test-server',
    uri: 'file:///data/config.json',
    name: 'Config File',
    mimeType: 'application/json',
    ...overrides,
  };
}

// ── ListMcpResources ─────────────────────────────────────────────────────

describe('ListMcpResources', () => {
  it('lists all resources from all servers', async () => {
    const manager = {
      getConnection: () => undefined,
      getServerResources: () => [],
      getAllResources: () => [
        makeResource({ server: 'srv-a', uri: 'file:///a.json', name: 'A' }),
        makeResource({ server: 'srv-a', uri: 'file:///b.json', name: 'B' }),
        makeResource({ server: 'srv-b', uri: 'pg://user_table', name: 'User Table', mimeType: 'text/sql' }),
      ],
    } as unknown as McpManager;

    const plugin = createListMcpResourcesPlugin(manager);
    const result = await plugin.executor({});

    expect(result.isError).toBe(false);
    expect(result.content).toContain('3 MCP resource(s) from 2 server(s)');
    expect(result.content).toContain('[srv-a]');
    expect(result.content).toContain('file:///a.json (application/json)');
    expect(result.content).toContain('file:///b.json (application/json)');
    expect(result.content).toContain('[srv-b]');
    expect(result.content).toContain('pg://user_table (text/sql)');
  });

  it('returns empty message when no resources exist', async () => {
    const manager = {
      getConnection: () => undefined,
      getServerResources: () => [],
      getAllResources: () => [],
    } as unknown as McpManager;

    const plugin = createListMcpResourcesPlugin(manager);
    const result = await plugin.executor({});

    expect(result.isError).toBe(false);
    expect(result.content).toContain('No MCP resources available');
    expect(result.metadata).toEqual({ resources: [], count: 0, serverCount: 0 });
  });

  it('filters resources by server name', async () => {
    const resources: ServerResource[] = [
      makeResource({ server: 'my-srv', uri: 'file:///x.txt', name: 'X' }),
      makeResource({ server: 'my-srv', uri: 'file:///y.txt', name: 'Y', mimeType: undefined }),
    ];

    const manager = {
      getConnection: (name: string) => name === 'my-srv' ? makeConnectedServer(name) : undefined,
      getServerResources: (name: string) => name === 'my-srv' ? resources : [],
      getAllResources: () => resources,
    } as unknown as McpManager;

    const plugin = createListMcpResourcesPlugin(manager);
    const result = await plugin.executor({ server: 'my-srv' });

    expect(result.isError).toBe(false);
    expect(result.content).toContain('2 MCP resource(s) from 1 server(s)');
    expect(result.content).toContain('[my-srv]');
    expect(result.content).toContain('file:///x.txt');
    expect(result.content).toContain('file:///y.txt');
  });

  it('returns error for unknown server', async () => {
    const manager = {
      getConnection: () => undefined,
      getServerResources: () => [],
      getAllResources: () => [],
    } as unknown as McpManager;

    const plugin = createListMcpResourcesPlugin(manager);
    const result = await plugin.executor({ server: 'ghost' });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('"ghost" is not connected');
  });

  it('returns error when server is not in connected state', async () => {
    const manager = {
      getConnection: (name: string) =>
        name === 'bad-srv' ? makeFailedServer(name) : undefined,
      getServerResources: () => [],
      getAllResources: () => [],
    } as unknown as McpManager;

    const plugin = createListMcpResourcesPlugin(manager);
    const result = await plugin.executor({ server: 'bad-srv' });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('not in connected state');
  });

  it('returns info message when server has no resources', async () => {
    const manager = {
      getConnection: (name: string) => name === 'empty-srv' ? makeConnectedServer(name) : undefined,
      getServerResources: () => [],
      getAllResources: () => [],
    } as unknown as McpManager;

    const plugin = createListMcpResourcesPlugin(manager);
    const result = await plugin.executor({ server: 'empty-srv' });

    expect(result.isError).toBe(false);
    expect(result.content).toContain('No resources available from server "empty-srv"');
  });

  it('includes description and size in formatted output', async () => {
    const manager = {
      getConnection: () => undefined,
      getServerResources: () => [],
      getAllResources: () => [
        makeResource({
          server: 'srv',
          uri: 'file:///report.pdf',
          name: 'Report',
          description: 'Annual report for 2025',
          size: 2_000_000,
        }),
      ],
    } as unknown as McpManager;

    const plugin = createListMcpResourcesPlugin(manager);
    const result = await plugin.executor({});

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Annual report for 2025');
    expect(result.content).toContain('1.9 MB');
  });

  it('truncates long descriptions', async () => {
    const longDesc = 'x'.repeat(200);
    const manager = {
      getConnection: () => undefined,
      getServerResources: () => [],
      getAllResources: () => [
        makeResource({ server: 'srv', uri: 'file:///f.txt', name: 'F', description: longDesc }),
      ],
    } as unknown as McpManager;

    const plugin = createListMcpResourcesPlugin(manager);
    const result = await plugin.executor({});

    expect(result.isError).toBe(false);
    // Description should be truncated to 120 chars + '...'
    expect(result.content).not.toContain(longDesc);
    expect(result.content).toContain(longDesc.slice(0, 117) + '...');
  });

  it('uses URI as fallback when name is empty', async () => {
    const manager = {
      getConnection: () => undefined,
      getServerResources: () => [],
      getAllResources: () => [
        makeResource({ server: 'srv', uri: 'file:///unnamed.dat', name: '' }),
      ],
    } as unknown as McpManager;

    const plugin = createListMcpResourcesPlugin(manager);
    const result = await plugin.executor({});

    expect(result.isError).toBe(false);
    expect(result.content).toContain('file:///unnamed.dat');
  });

  it('paramSummary shows server filter or "all servers"', () => {
    const manager = {} as McpManager;
    const plugin = createListMcpResourcesPlugin(manager);

    expect(plugin.paramSummary!({})).toBe('all servers');
    expect(plugin.paramSummary!({ server: 'foo' })).toBe('server: foo');
  });

  it('isEnabled returns true', () => {
    const plugin = createListMcpResourcesPlugin({} as McpManager);
    expect(plugin.isEnabled()).toBe(true);
  });
});

// ── ReadMcpResource ──────────────────────────────────────────────────────

describe('ReadMcpResource', () => {
  beforeEach(() => {
    mockReadResource.mockReset();
  });

  it('reads a text resource and formats output', async () => {
    const connected = makeConnectedServer('srv');
    const manager = {
      getConnection: (name: string) => name === 'srv' ? connected : undefined,
    } as unknown as McpManager;

    mockReadResource.mockResolvedValueOnce({
      contents: [{ uri: 'file:///a.txt', mimeType: 'text/plain', text: 'Hello, world!' }],
    });

    const plugin = createReadMcpResourcePlugin(manager);
    const result = await plugin.executor({ server: 'srv', uri: 'file:///a.txt' });

    expect(result.isError).toBe(false);
    expect(result.content).toContain('=== Resource: file:///a.txt ===');
    expect(result.content).toContain('Server: srv');
    expect(result.content).toContain('MIME type: text/plain');
    expect(result.content).toContain('Hello, world!');
    expect(result.content).toContain('=== End of resource ===');
    expect(result.metadata!.server).toBe('srv');
    expect(result.metadata!.uri).toBe('file:///a.txt');
    expect(result.metadata!.contentCount).toBe(1);
  });

  it('returns error for unknown server', async () => {
    const manager = {
      getConnection: () => undefined,
    } as unknown as McpManager;

    const plugin = createReadMcpResourcePlugin(manager);
    const result = await plugin.executor({ server: 'ghost', uri: 'file:///x' });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('"ghost" is not connected');
  });

  it('returns error for non-connected server', async () => {
    const manager = {
      getConnection: (name: string) => name === 'bad' ? makeFailedServer(name) : undefined,
    } as unknown as McpManager;

    const plugin = createReadMcpResourcePlugin(manager);
    const result = await plugin.executor({ server: 'bad', uri: 'file:///x' });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('not in connected state');
  });

  it('returns error when server does not support resources', async () => {
    const noResCap: ServerConnection = {
      name: 'srv',
      type: 'connected',
      client: {} as any,
      capabilities: { tools: {} }, // no resources cap
      config: { command: 'cmd', scope: 'local' },
      cleanup: async () => {},
    };

    const manager = {
      getConnection: () => noResCap,
    } as unknown as McpManager;

    const plugin = createReadMcpResourcePlugin(manager);
    const result = await plugin.executor({ server: 'srv', uri: 'file:///x' });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('does not support resources');
  });

  it('returns error when readResource returns null', async () => {
    const connected = makeConnectedServer('srv');
    const manager = {
      getConnection: () => connected,
    } as unknown as McpManager;

    mockReadResource.mockResolvedValueOnce(null);

    const plugin = createReadMcpResourcePlugin(manager);
    const result = await plugin.executor({ server: 'srv', uri: 'file:///missing' });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Failed to read resource');
  });

  it('returns info when contents array is empty', async () => {
    const connected = makeConnectedServer('srv');
    const manager = {
      getConnection: () => connected,
    } as unknown as McpManager;

    mockReadResource.mockResolvedValueOnce({ contents: [] });

    const plugin = createReadMcpResourcePlugin(manager);
    const result = await plugin.executor({ server: 'srv', uri: 'file:///empty' });

    expect(result.isError).toBe(false);
    expect(result.content).toContain('returned empty contents');
    expect(result.metadata!.contentCount).toBe(0);
  });

  it('handles multiple content parts', async () => {
    const connected = makeConnectedServer('srv');
    const manager = {
      getConnection: () => connected,
    } as unknown as McpManager;

    mockReadResource.mockResolvedValueOnce({
      contents: [
        { uri: 'file:///multi', text: 'Part 1' },
        { uri: 'file:///multi', text: 'Part 2' },
        { uri: 'file:///multi', text: 'Part 3' },
      ],
    });

    const plugin = createReadMcpResourcePlugin(manager);
    const result = await plugin.executor({ server: 'srv', uri: 'file:///multi' });

    expect(result.isError).toBe(false);
    expect(result.content).toContain('--- Content part 1/3 ---');
    expect(result.content).toContain('Part 1');
    expect(result.content).toContain('--- Content part 2/3 ---');
    expect(result.content).toContain('Part 2');
    expect(result.content).toContain('--- Content part 3/3 ---');
    expect(result.content).toContain('Part 3');
    expect(result.metadata!.contentCount).toBe(3);
  });

  it('handles blob (binary) content', async () => {
    const connected = makeConnectedServer('srv');
    const manager = {
      getConnection: () => connected,
    } as unknown as McpManager;

    mockReadResource.mockResolvedValueOnce({
      contents: [{
        uri: 'file:///img.png',
        mimeType: 'image/png',
        blob: 'iVBORw0KGgoAAAANSUhEUg==',
      }],
    });

    const plugin = createReadMcpResourcePlugin(manager);
    const result = await plugin.executor({ server: 'srv', uri: 'file:///img.png' });

    expect(result.isError).toBe(false);
    expect(result.content).toContain('MIME type: image/png (binary)');
    expect(result.content).toContain('[Binary data: base64-encoded blob');
    expect(result.content).toContain('iVBORw0KGgoAAAANSUhEUg==');
  });

  it('truncates text content exceeding 50,000 chars', async () => {
    const connected = makeConnectedServer('srv');
    const manager = {
      getConnection: () => connected,
    } as unknown as McpManager;

    // Use distinguishable content: 'A' for the kept portion, 'B' for the truncated tail
    const keepText = 'A'.repeat(50_000);
    const tailText = 'B'.repeat(30_000);
    const bigText = keepText + tailText;
    mockReadResource.mockResolvedValueOnce({
      contents: [{ uri: 'file:///big.txt', text: bigText }],
    });

    const plugin = createReadMcpResourcePlugin(manager);
    const result = await plugin.executor({ server: 'srv', uri: 'file:///big.txt' });

    expect(result.isError).toBe(false);
    expect(result.content).toContain('[Content truncated: 80000 total chars, showing first 50,000]');
    // The kept portion is present
    expect(result.content).toContain(keepText);
    // The tail (B characters) should NOT appear — they were truncated away
    expect(result.content).not.toContain('BBBBBBBBBB');
  });

  it('handles single content item (not array)', async () => {
    const connected = makeConnectedServer('srv');
    const manager = {
      getConnection: () => connected,
    } as unknown as McpManager;

    mockReadResource.mockResolvedValueOnce({
      contents: { uri: 'file:///single', text: 'Just one' },
    });

    const plugin = createReadMcpResourcePlugin(manager);
    const result = await plugin.executor({ server: 'srv', uri: 'file:///single' });

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Just one');
    // No "Content part" label for single items
    expect(result.content).not.toContain('Content part');
  });

  it('paramSummary trims long URIs', () => {
    const plugin = createReadMcpResourcePlugin({} as McpManager);
    const short = 'file:///short.txt';
    const long = 'file:///very/long/path/that/exceeds/fifty/characters/in/total.txt';

    expect(plugin.paramSummary!({ uri: short })).toBe(short);
    expect(plugin.paramSummary!({ uri: long })).toBe(long.slice(0, 47) + '...');
  });

  it('isEnabled returns true', () => {
    const plugin = createReadMcpResourcePlugin({} as McpManager);
    expect(plugin.isEnabled()).toBe(true);
  });

  it('handles unknown content type via JSON stringify', async () => {
    const connected = makeConnectedServer('srv');
    const manager = {
      getConnection: () => connected,
    } as unknown as McpManager;

    mockReadResource.mockResolvedValueOnce({
      contents: [{ uri: 'file:///odd', customField: 'value', other: 42 }],
    });

    const plugin = createReadMcpResourcePlugin(manager);
    const result = await plugin.executor({ server: 'srv', uri: 'file:///odd' });

    expect(result.isError).toBe(false);
    expect(result.content).toContain('"customField"');
    expect(result.content).toContain('"value"');
    expect(result.content).toContain('42');
  });
});
