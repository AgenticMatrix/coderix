/**
 * src/mcp/index.ts — Public API for Coderix MCP integration.
 */

// Manager (main entry point)
export { McpManager, hasMcpConfig, loadEnabledMcpConfigs } from './manager.js';
export type { ToolsChangedCallback } from './manager.js';

// Types
export type {
  ConfigScope,
  Transport,
  ServerConfig,
  ScopedServerConfig,
  StdioServerConfig,
  HttpServerConfig,
  SSEServerConfig,
  McpJsonConfig,
  ServerConnection,
  ConnectedServer,
  FailedServer,
  PendingServer,
  DisabledServer,
  ServerResource,
  SerializedMcpTool,
} from './types.js';

// Config schemas (for validation)
export {
  ServerConfigSchema,
  McpJsonConfigSchema,
  StdioServerConfigSchema,
  HttpServerConfigSchema,
  SSEServerConfigSchema,
} from './types.js';

// Tool helpers
export { buildMcpToolName, parseMcpToolName } from './mcp-tool.js';

// Resource tools
export {
  createListMcpResourcesPlugin,
  createReadMcpResourcePlugin,
} from './mcp-resource-tools.js';

// Connection
export { connectToServer, CONNECT_TIMEOUT_MS } from './connection.js';

// Discovery (tools + resources)
export { discoverTools, discoverResources, readResource } from './discovery.js';

// MCP Server mode
export { startMcpServer } from './mcp-server.js';

// MCP Skills
export { discoverMcpSkills, formatMcpSkillsForPrompt } from './mcp-skills.js';
export type { McpSkill } from './mcp-skills.js';

// Config loader
export {
  loadMcpConfigs,
  addMcpConfig,
  removeMcpConfig,
  getMcpConfig,
  listMcpServerNames,
  projectConfigPath,
  userConfigPath,
  isServerDisabled,
  disableServer,
  enableServer,
  listDisabledServerNames,
} from './config-loader.js';
