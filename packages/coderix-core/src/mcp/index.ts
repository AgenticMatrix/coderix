/**
 * src/mcp/index.ts — Public API for Coderix MCP integration.
 */

// Manager (main entry point)
export { McpManager, hasMcpConfig, loadEnabledMcpConfigs } from './manager.js';
export type { ToolsChangedCallback, ServerChangedCallback, ServerChangedKind, McpServerStatus } from './manager.js';

// Types
export type {
  ConfigScope,
  Transport,
  ServerConfig,
  ScopedServerConfig,
  StdioServerConfig,
  HttpServerConfig,
  SSEServerConfig,
  McpOAuthConfig,
  McpJsonConfig,
  ServerConnection,
  ConnectedServer,
  FailedServer,
  NeedsAuthServer,
  PendingServer,
  DisabledServer,
  ServerResource,
  McpPrompt,
  McpPromptArgument,
  SerializedMcpTool,
} from './types.js';

// Config schemas (for validation)
export {
  ServerConfigSchema,
  McpJsonConfigSchema,
  StdioServerConfigSchema,
  HttpServerConfigSchema,
  SSEServerConfigSchema,
  McpOAuthConfigSchema,
} from './types.js';

// Tool helpers
export { buildMcpToolName, parseMcpToolName } from './mcp-tool.js';

// Prompt helpers
export {
  buildMcpPromptName,
  parseMcpPromptName,
  renderMcpPromptMessages,
  parsePromptArgs,
  describeMcpPrompt,
} from './mcp-prompt.js';

// Resource tools
export {
  createListMcpResourcesPlugin,
  createReadMcpResourcePlugin,
} from './mcp-resource-tools.js';

// Connection
export {
  connectToServer,
  completeOAuthAuthorization,
  resolveServerEnv,
  CONNECT_TIMEOUT_MS,
} from './connection.js';
export type { ConnectHooks } from './connection.js';

// Bundle (installed server package paths)
export { installedMcpDir, installedConfigPath, mcpSecretsPath } from './bundle.js';

// Secrets (~/.coderix/mcp/secrets.json)
export {
  getServerSecrets,
  getSecret,
  setSecret,
  clearServerSecrets,
  listServersWithSecrets,
} from './secrets.js';

// OAuth
export {
  FileOAuthProvider,
  createOAuthProvider,
  clearOAuthCredentials,
  openUrlInBrowser,
  hasOAuthConfig,
  mcpAuthStorePath,
  DEFAULT_OAUTH_CALLBACK_PORT,
} from './oauth.js';

// Catalog metadata (display-only enrichment for the desktop 链接器)
export { MCP_CATALOG_META, getCatalogMeta } from './catalog.js';
export type { McpCatalogMeta, McpCatalogField } from './catalog.js';

// Connection test (standalone connect + tools/list)
export { testMcpServer } from './test.js';
export type { McpTestResult, McpTestTool } from './test.js';

// Discovery (tools + resources + prompts)
export {
  discoverTools,
  discoverResources,
  readResource,
  discoverPrompts,
  getPrompt,
} from './discovery.js';

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
  isServerRemoved,
  removeServerPermanently,
  restoreServer,
  listRemovedServerNames,
} from './config-loader.js';
