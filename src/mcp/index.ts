/**
 * src/mcp/index.ts — Public API for Coderix MCP integration.
 */

// Manager (main entry point)
export { McpManager, hasMcpConfig } from './manager.js';

// Types
export type {
  ConfigScope,
  Transport,
  ServerConfig,
  ScopedServerConfig,
  StdioServerConfig,
  HttpServerConfig,
  McpJsonConfig,
  ServerConnection,
  ConnectedServer,
  FailedServer,
  PendingServer,
  DisabledServer,
  SerializedMcpTool,
} from './types.js';

// Config schemas (for validation)
export {
  ServerConfigSchema,
  McpJsonConfigSchema,
  StdioServerConfigSchema,
  HttpServerConfigSchema,
} from './types.js';

// Tool helpers
export { buildMcpToolName, parseMcpToolName } from './mcp-tool.js';

// Connection (for advanced use)
export { connectToServer, CONNECT_TIMEOUT_MS } from './connection.js';

// Discovery (for advanced use)
export { discoverTools } from './discovery.js';

// Config loader (for advanced use)
export {
  loadMcpConfigs,
  addMcpConfig,
  removeMcpConfig,
  getMcpConfig,
  listMcpServerNames,
  projectConfigPath,
  userConfigPath,
} from './config-loader.js';
