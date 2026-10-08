/**
 * Demo MCP — Tool Implementations
 *
 * Pure handlers (no I/O) so they can be unit-tested directly. Each returns the
 * MCP `content` array shape consumed by the server's `tools/call` handler.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { DEMO_TOOLS } from './tools.js';

export type DemoToolResult = CallToolResult;

const SERVER_NAME = 'coderix-demo-mcp';
const SERVER_VERSION = '0.1.0';

/** Dispatch a `tools/call` to its implementation. Unknown tools error. */
export async function handleDemoToolCall(
  name: string,
  args: Record<string, unknown>,
): Promise<DemoToolResult> {
  switch (name) {
    case 'echo':
      return handleEcho(args);
    case 'get_time':
      return handleGetTime(args);
    case 'calc':
      return handleCalc(args);
    case 'server_info':
      return handleServerInfo();
    default:
      return text(`Unknown tool: ${name}`, true);
  }
}

function handleEcho(args: Record<string, unknown>): DemoToolResult {
  const message = typeof args.message === 'string' ? args.message : '';
  if (!message) {
    return text('Missing required argument "message".', true);
  }
  return text(message);
}

function handleGetTime(args: Record<string, unknown>): DemoToolResult {
  const timezone = typeof args.timezone === 'string' ? args.timezone : undefined;
  const now = new Date();

  if (timezone) {
    try {
      const formatted = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        dateStyle: 'full',
        timeStyle: 'long',
      }).format(now);
      return text(`${formatted} (${timezone})\n${now.toISOString()}`);
    } catch {
      return text(`Unknown timezone: ${timezone}`, true);
    }
  }

  return text(now.toISOString());
}

function handleCalc(args: Record<string, unknown>): DemoToolResult {
  const operation = args.operation;
  const a = args.a;
  const b = args.b;

  if (
    operation !== 'add' &&
    operation !== 'subtract' &&
    operation !== 'multiply' &&
    operation !== 'divide'
  ) {
    return text(`Unsupported operation: ${String(operation)}`, true);
  }
  if (typeof a !== 'number' || typeof b !== 'number' || Number.isNaN(a) || Number.isNaN(b)) {
    return text('Arguments "a" and "b" must be numbers.', true);
  }
  if (operation === 'divide' && b === 0) {
    return text('Division by zero is not allowed.', true);
  }

  const result =
    operation === 'add'
      ? a + b
      : operation === 'subtract'
        ? a - b
        : operation === 'multiply'
          ? a * b
          : a / b;

  return text(String(result));
}

function handleServerInfo(): DemoToolResult {
  const tools = DEMO_TOOLS.map((t) => t.name).join(', ');
  return text(
    `${SERVER_NAME} v${SERVER_VERSION}\n` +
      `A reference MCP server for Coderix.\n` +
      `Tools: ${tools}`,
  );
}

function text(value: string, isError = false): DemoToolResult {
  const result: DemoToolResult = { content: [{ type: 'text', text: value }] };
  if (isError) result.isError = true;
  return result;
}
