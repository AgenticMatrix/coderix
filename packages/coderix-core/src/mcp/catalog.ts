/**
 * MCP catalog metadata — display-only enrichment for the known servers shipped
 * in the installed bundle (`~/.coderix/mcp/config.json`).
 *
 * The bundle config carries only connection details (command/args/url/secretEnv);
 * the desktop 链接器 renders richer cards (icon, bilingual name & description,
 * credential tag, optional path fields). Metadata lives here so both the
 * desktop and any future CLI surface share one source of truth. Unknown
 * (user-added) servers fall back to a generic entry — they still render.
 */

export interface McpCatalogField {
  key: string;
  labelZh: string;
  labelEn: string;
  placeholder?: string;
  /** stdio: replace `args[argIndex]` with the user value (e.g. allowed dir). */
  argIndex?: number;
  /** stdio: store the value as this secret env var (password input). */
  envKey?: string;
  /** http/sse: send the value under this header. */
  headerKey?: string;
  /** Header value prefix, e.g. `Bearer `. */
  headerPrefix?: string;
  /** Render a password-style input (default false). */
  secret?: boolean;
}

export interface McpCatalogMeta {
  /** Emoji shown in the card avatar. */
  icon: string;
  nameZh: string;
  nameEn: string;
  descriptionZh: string;
  descriptionEn: string;
  /** Display-only credential tag (env var name), e.g. `GITHUB_TOKEN`. */
  credential?: string;
  /** Extra fields the config dialog should prompt for. */
  fields?: McpCatalogField[];
}

const FALLBACK: Omit<McpCatalogMeta, 'nameZh' | 'nameEn'> = {
  icon: '🔌',
  descriptionZh: '自定义 MCP 服务',
  descriptionEn: 'Custom MCP server',
};

/** Known catalog servers, keyed by the name used in `mcp.json`. */
export const MCP_CATALOG_META: Record<string, McpCatalogMeta> = {
  filesystem: {
    icon: '📁',
    nameZh: '文件系统',
    nameEn: 'Filesystem',
    descriptionZh: '读写本地指定目录的文件，支持搜索、读取、写入与编辑。',
    descriptionEn: 'Read and write files in a local directory — search, read, write and edit.',
    fields: [
      {
        key: 'dir',
        labelZh: '允许访问的目录',
        labelEn: 'Allowed directory',
        placeholder: '/Users/me/Documents',
        argIndex: 2,
      },
    ],
  },
  memory: {
    icon: '🧠',
    nameZh: '知识图谱记忆',
    nameEn: 'Memory',
    descriptionZh: '在本地知识图谱中创建实体、关系与观察记录，跨会话检索。',
    descriptionEn: 'Create entities, relations and observations in a local knowledge graph.',
  },
  'sequential-thinking': {
    icon: '🤔',
    nameZh: '序列化思考',
    nameEn: 'Sequential Thinking',
    descriptionZh: '把复杂问题拆解为可回溯的逐步推理链，支持动态修正。',
    descriptionEn: 'Break complex problems into a revisable step-by-step reasoning chain.',
  },
  playwright: {
    icon: '🎭',
    nameZh: 'Playwright 浏览器',
    nameEn: 'Playwright',
    descriptionZh: '驱动真实浏览器进行导航、点击、输入与网页内容提取。',
    descriptionEn: 'Control a real browser — navigate, click, type and extract web content.',
  },
  context7: {
    icon: '📚',
    nameZh: 'Context7 文档',
    nameEn: 'Context7',
    descriptionZh: '按需拉取任意编程库/框架的最新官方文档与代码示例。',
    descriptionEn: 'Fetch up-to-date docs and code examples for any library or framework.',
  },
  github: {
    icon: '🐙',
    nameZh: 'GitHub',
    nameEn: 'GitHub',
    descriptionZh: '操作仓库、Issue、PR 与工作流，搜索代码与用户。',
    descriptionEn: 'Manage repos, issues, PRs and workflows; search code and users.',
    credential: 'GITHUB_PERSONAL_ACCESS_TOKEN',
  },
  tavily: {
    icon: '🔎',
    nameZh: 'Tavily 联网搜索',
    nameEn: 'Tavily Search',
    descriptionZh: '面向 AI 的实时网页搜索与内容抽取。',
    descriptionEn: 'Real-time web search and content extraction tuned for AI agents.',
    credential: 'TAVILY_API_KEY',
  },
};

/** Metadata for a server, falling back to a generic entry for custom servers. */
export function getCatalogMeta(name: string): McpCatalogMeta {
  const known = MCP_CATALOG_META[name];
  if (known) return known;
  return { ...FALLBACK, nameZh: name, nameEn: name };
}
