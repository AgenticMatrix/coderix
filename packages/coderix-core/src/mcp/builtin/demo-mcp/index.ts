/**
 * Demo MCP — Public API
 */

export { createDemoMcpServer, runDemoMcpServer } from './mcp-server.js';
export { DEMO_TOOLS } from './tools.js';
export type { DemoToolName } from './tools.js';
export { handleDemoToolCall } from './handlers.js';
export type { DemoToolResult } from './handlers.js';
