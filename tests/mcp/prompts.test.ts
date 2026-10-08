/**
 * MCP prompts — discovery and rendering.
 */

import { describe, it, expect } from 'vitest';
import type { ConnectedServer } from '../../packages/coderix-core/src/mcp/types.js';
import {
  discoverPrompts,
  getPrompt,
} from '../../packages/coderix-core/src/mcp/discovery.js';
import {
  buildMcpPromptName,
  parseMcpPromptName,
  renderMcpPromptMessages,
  parsePromptArgs,
} from '../../packages/coderix-core/src/mcp/mcp-prompt.js';

function makeServer(
  capabilities: ConnectedServer['capabilities'],
  request: (req: { method: string }) => Promise<unknown>,
): ConnectedServer {
  return {
    name: 'test',
    type: 'connected',
    client: { request } as unknown as ConnectedServer['client'],
    capabilities,
    config: { command: 'x', scope: 'local' },
    cleanup: async () => {},
  };
}

describe('discoverPrompts', () => {
  it('returns [] when the server does not advertise prompts', async () => {
    const server = makeServer({}, async () => ({}));
    expect(await discoverPrompts(server)).toEqual([]);
  });

  it('maps prompts/list into McpPrompt objects', async () => {
    const server = makeServer({ prompts: {} }, async (req) => {
      expect(req.method).toBe('prompts/list');
      return {
        prompts: [
          {
            name: 'greet',
            title: 'Greet',
            description: 'Say hi',
            arguments: [{ name: 'name', description: 'who', required: true }],
          },
        ],
      };
    });

    const prompts = await discoverPrompts(server);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({
      serverName: 'test',
      name: 'greet',
      title: 'Greet',
      arguments: [{ name: 'name', required: true }],
    });
  });

  it('returns [] on request failure', async () => {
    const server = makeServer({ prompts: {} }, async () => {
      throw new Error('boom');
    });
    expect(await discoverPrompts(server)).toEqual([]);
  });
});

describe('getPrompt', () => {
  it('returns null when prompts are unsupported', async () => {
    const server = makeServer({}, async () => ({}));
    expect(await getPrompt(server, 'greet')).toBeNull();
  });

  it('passes arguments through prompts/get', async () => {
    const server = makeServer({ prompts: {} }, async (req) => {
      expect(req).toEqual({ method: 'prompts/get', params: { name: 'greet', arguments: { name: 'Ada' } } });
      return { messages: [{ role: 'user', content: { type: 'text', text: 'hi Ada' } }] };
    });
    const result = await getPrompt(server, 'greet', { name: 'Ada' });
    expect(result?.messages[0]?.content).toEqual({ type: 'text', text: 'hi Ada' });
  });
});

describe('prompt naming', () => {
  it('builds and parses the mcp__server__prompt form', () => {
    const name = buildMcpPromptName('my server', 'greet.everyone');
    expect(name).toBe('mcp__my_server__greet_everyone');
    expect(parseMcpPromptName(name)).toEqual({
      serverName: 'my_server',
      promptName: 'greet_everyone',
    });
  });

  it('returns null for non-MCP names', () => {
    expect(parseMcpPromptName('bash')).toBeNull();
  });
});

describe('renderMcpPromptMessages', () => {
  it('joins text blocks', () => {
    const text = renderMcpPromptMessages([
      { role: 'user', content: { type: 'text', text: 'Hello' } },
      { role: 'assistant', content: { type: 'text', text: 'World' } },
    ] as never);
    expect(text).toBe('Hello\n\nWorld');
  });

  it('renders images as placeholders and resources as JSON', () => {
    const text = renderMcpPromptMessages([
      { role: 'user', content: { type: 'image', mimeType: 'image/png', data: 'AAAA' } },
      { role: 'user', content: { type: 'resource', resource: { uri: 'file:///x', text: 'hi' } } },
    ] as never);
    expect(text).toContain('[Image content omitted: image/png]');
    expect(text).toContain('file:///x');
  });
});

describe('parsePromptArgs', () => {
  it('maps key=value pairs', () => {
    expect(parsePromptArgs('name=Ada language=French')).toEqual({ name: 'Ada', language: 'French' });
  });

  it('assigns positionals to declared keys in order', () => {
    expect(parsePromptArgs('Ada French', ['name', 'language'])).toEqual({
      name: 'Ada',
      language: 'French',
    });
  });

  it('handles quoted values', () => {
    expect(parsePromptArgs('text="hello world"')).toEqual({ text: 'hello world' });
  });
});
