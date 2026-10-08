/**
 * Demo MCP — Server Factory + Subprocess Entry Point.
 *
 * createDemoMcpServer(): creates a standard MCP Server exposing the demo tools
 *                        and one prompt template.
 * runDemoMcpServer():    starts the server over stdio as a subprocess.
 *
 * Usage as subprocess:
 *   coderix --demo-mcp
 *
 * This is the in-process counterpart to examples/mcp/demo-server.mjs, which
 * speaks the same protocol as a standalone script.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { DEMO_TOOLS } from './tools.js';
import { handleDemoToolCall } from './handlers.js';
import { onShutdownSignal } from '../../../utils/platform.js';

/** Prompt templates the demo server advertises via `prompts/list`. */
const DEMO_PROMPTS = [
  {
    name: 'greet',
    title: 'Greet someone',
    description: 'Produce a short, friendly greeting for the named person.',
    arguments: [{ name: 'name', description: 'Who to greet.', required: true }],
  },
  {
    name: 'summarize',
    title: 'Summarize text',
    description: 'Ask the model to summarize a block of text.',
    arguments: [
      { name: 'text', description: 'The text to summarize.', required: true },
      { name: 'language', description: 'Output language (default: English).', required: false },
    ],
  },
] as const;

/**
 * Create an MCP Server pre-configured with the demo tools and prompts.
 * Call server.connect(transport) to activate.
 */
export function createDemoMcpServer(): { server: Server } {
  const server = new Server(
    {
      name: 'coderix-demo-mcp',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
        prompts: {},
      },
    },
  );

  // ── tools/list ─────────────────────────────────────────────────
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: DEMO_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  // ── tools/call ─────────────────────────────────────────────────
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const { name, arguments: args } = params;
    try {
      return await handleDemoToolCall(name, (args ?? {}) as Record<string, unknown>);
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Tool "${name}" error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  });

  // ── prompts/list ───────────────────────────────────────────────
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: DEMO_PROMPTS.map((p) => ({
      name: p.name,
      title: p.title,
      description: p.description,
      arguments: p.arguments.map((a) => ({ ...a })),
    })),
  }));

  // ── prompts/get ────────────────────────────────────────────────
  server.setRequestHandler(GetPromptRequestSchema, async ({ params }) => {
    const { name, arguments: args } = params;
    const argsRecord = (args ?? {}) as Record<string, string>;

    if (name === 'greet') {
      const who = argsRecord.name ?? 'there';
      return {
        description: `Greeting for ${who}`,
        messages: [
          {
            role: 'user' as const,
            content: { type: 'text' as const, text: `Please greet ${who} warmly in one sentence.` },
          },
        ],
      };
    }

    if (name === 'summarize') {
      const language = argsRecord.language ?? 'English';
      const text = argsRecord.text ?? '';
      return {
        description: 'Summarize text',
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Summarize the following text in ${language}:\n\n${text}`,
            },
          },
        ],
      };
    }

    throw new Error(`Unknown prompt: ${name}`);
  });

  return { server };
}

/**
 * Start the Demo MCP server over stdio (subprocess entry point).
 * Blocks until stdin closes.
 */
export async function runDemoMcpServer(): Promise<void> {
  const log = (msg: string) => {
    // stderr only — stdout is the MCP protocol channel.
    process.stderr.write(`[coderix-demo-mcp] ${msg}\n`);
  };

  log('Starting demo MCP server on stdio...');

  const { server } = createDemoMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  log(`Ready — ${DEMO_TOOLS.length} tools, ${DEMO_PROMPTS.length} prompts`);

  await new Promise<void>((resolve) => onShutdownSignal(resolve));

  log('Shutting down...');
  await server.close();
}
