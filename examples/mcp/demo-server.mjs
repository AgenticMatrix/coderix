#!/usr/bin/env node
/**
 * Standalone Demo MCP server.
 *
 * A self-contained reference MCP server (no Coderix imports) that speaks
 * JSON-RPC over stdio. It exists to demonstrate the "external server" side of
 * MCP integration: point a Coderix config at it and its tools/prompts show up
 * like any other MCP server.
 *
 *   Run directly:     node examples/mcp/demo-server.mjs
 *   Via npm script:   pnpm mcp:demo
 *   Via Coderix TUI:  copy examples/mcp/mcp.json to <project>/.coderix/mcp.json
 *
 * It exposes the same surface as the built-in `coderix --demo-mcp` server:
 *   Tools:   echo, get_time, calc, server_info
 *   Prompts: greet, summarize
 *
 * Requires @modelcontextprotocol/sdk (already a repo dependency).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const SERVER_NAME = 'coderix-demo-mcp';
const SERVER_VERSION = '0.1.0';

// ── Tools ──────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo the provided message back. Useful for verifying connectivity.',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string', description: 'The message to echo back.' } },
      required: ['message'],
    },
  },
  {
    name: 'get_time',
    description: 'Return the current date and time as an ISO-8601 string.',
    inputSchema: {
      type: 'object',
      properties: { timezone: { type: 'string', description: 'Optional IANA timezone.' } },
      required: [],
    },
  },
  {
    name: 'calc',
    description: 'Evaluate a basic arithmetic operation on two numbers.',
    inputSchema: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['add', 'subtract', 'multiply', 'divide'] },
        a: { type: 'number' },
        b: { type: 'number' },
      },
      required: ['operation', 'a', 'b'],
    },
  },
  {
    name: 'server_info',
    description: 'Describe this demo MCP server.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

const PROMPTS = [
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
];

// ── Handlers ───────────────────────────────────────────────────────────

function text(value, isError = false) {
  const result = { content: [{ type: 'text', text: value }] };
  if (isError) result.isError = true;
  return result;
}

function callTool(name, args) {
  switch (name) {
    case 'echo': {
      const message = typeof args.message === 'string' ? args.message : '';
      return message ? text(message) : text('Missing required argument "message".', true);
    }
    case 'get_time': {
      const now = new Date();
      const tz = typeof args.timezone === 'string' ? args.timezone : undefined;
      if (tz) {
        try {
          const formatted = new Intl.DateTimeFormat('en-CA', {
            timeZone: tz,
            dateStyle: 'full',
            timeStyle: 'long',
          }).format(now);
          return text(`${formatted} (${tz})\n${now.toISOString()}`);
        } catch {
          return text(`Unknown timezone: ${tz}`, true);
        }
      }
      return text(now.toISOString());
    }
    case 'calc': {
      const { operation, a, b } = args;
      if (!['add', 'subtract', 'multiply', 'divide'].includes(operation)) {
        return text(`Unsupported operation: ${String(operation)}`, true);
      }
      if (typeof a !== 'number' || typeof b !== 'number') {
        return text('Arguments "a" and "b" must be numbers.', true);
      }
      if (operation === 'divide' && b === 0) {
        return text('Division by zero is not allowed.', true);
      }
      const result =
        operation === 'add' ? a + b
          : operation === 'subtract' ? a - b
            : operation === 'multiply' ? a * b
              : a / b;
      return text(String(result));
    }
    case 'server_info':
      return text(
        `${SERVER_NAME} v${SERVER_VERSION}\n` +
          `A standalone reference MCP server.\n` +
          `Tools: ${TOOLS.map((t) => t.name).join(', ')}`,
      );
    default:
      return text(`Unknown tool: ${name}`, true);
  }
}

function getPrompt(name, args) {
  if (name === 'greet') {
    const who = args.name ?? 'there';
    return {
      description: `Greeting for ${who}`,
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: `Please greet ${who} warmly in one sentence.` },
        },
      ],
    };
  }
  if (name === 'summarize') {
    const language = args.language ?? 'English';
    const body = args.text ?? '';
    return {
      description: 'Summarize text',
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: `Summarize the following text in ${language}:\n\n${body}` },
        },
      ],
    };
  }
  throw new Error(`Unknown prompt: ${name}`);
}

// ── Server ─────────────────────────────────────────────────────────────

const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  { capabilities: { tools: {}, prompts: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  try {
    return callTool(params.name, params.arguments ?? {});
  } catch (err) {
    return text(`Tool "${params.name}" error: ${err.message}`, true);
  }
});

server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS }));

server.setRequestHandler(GetPromptRequestSchema, async ({ params }) => {
  return getPrompt(params.name, params.arguments ?? {});
});

const transport = new StdioServerTransport();
await server.connect(transport);
// stderr only — stdout is the protocol channel.
process.stderr.write(`[${SERVER_NAME}] ready on stdio (${TOOLS.length} tools, ${PROMPTS.length} prompts)\n`);
