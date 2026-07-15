import type { ToolUseBlock } from '../../types.js';

export interface CollapsedGroup {
  type: 'search' | 'read';
  blocks: ToolUseBlock[];
  searchCount: number;
  readCount: number;
  listCount: number;
  latestHint: string;
  isActive: boolean;
}

const BASH_SEARCH_COMMANDS = new Set([
  'find', 'grep', 'rg', 'ag', 'ack', 'locate', 'which', 'whereis', 'glob',
]);

const BASH_LIST_COMMANDS = new Set(['ls', 'tree', 'du']);

function extractBaseCommand(segment: string): string {
  return segment.trim().split(/\s+/)[0] ?? '';
}

function detectBashCommandType(command: string): { isSearch: boolean; isRead: boolean; isList: boolean } {
  const segments = command.split(/[|;&]+/);
  let isSearch = false;
  let isRead = false;
  let isList = false;

  for (const seg of segments) {
    const trimmed = seg.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('>') || trimmed.startsWith('<')) continue;

    const base = extractBaseCommand(trimmed);
    if (!base) continue;

    if (BASH_SEARCH_COMMANDS.has(base)) {
      isSearch = true;
    } else if (BASH_LIST_COMMANDS.has(base)) {
      isList = true;
    } else {
      return { isSearch: false, isRead: false, isList: false };
    }
  }

  return { isSearch, isRead, isList };
}

function isSearchBlock(block: ToolUseBlock): boolean {
  if (block.toolName === 'grep' || block.toolName === 'glob') return true;
  if (block.toolName === 'bash') {
    const cmd = (block.input.command as string) ?? '';
    return detectBashCommandType(cmd).isSearch;
  }
  return false;
}

function isReadBlock(block: ToolUseBlock): { isRead: boolean; isList: boolean } {
  if (block.toolName === 'read') return { isRead: true, isList: false };
  if (block.toolName === 'bash') {
    const cmd = (block.input.command as string) ?? '';
    return detectBashCommandType(cmd);
  }
  return { isRead: false, isList: false };
}

function getSearchHint(block: ToolUseBlock): string {
  if (block.toolName === 'grep') {
    const pattern = (block.input.pattern as string) ?? '';
    const hint = `grep (${pattern})`;
    return hint.length > 80 ? hint.slice(0, 77) + '...' : hint;
  }
  if (block.toolName === 'glob') {
    const pattern = (block.input.pattern as string) ?? '';
    const hint = `glob (${pattern})`;
    return hint.length > 80 ? hint.slice(0, 77) + '...' : hint;
  }
  if (block.toolName === 'bash') {
    const cmd = (block.input.command as string) ?? '';
    const cleaned = `bash(${cmd.replace(/\s+/g, ' ').trim()})`;
    return cleaned.length > 80 ? cleaned.slice(0, 77) + '...' : cleaned;
  }
  return '';
}

function getReadHint(block: ToolUseBlock): string {
  if (block.toolName === 'read') {
    const fp = (block.input.file_path as string) ?? '';
    return fp.length > 150 ? '...' + fp.slice(-147) : fp;
  }
  if (block.toolName === 'bash') {
    const cmd = (block.input.command as string) ?? '';
    const cleaned = '$ ' + cmd.replace(/\s+/g, ' ').trim();
    return cleaned.length > 80 ? cleaned.slice(0, 77) + '...' : cleaned;
  }
  return '';
}

/**
 * Groups search/read tool_use blocks within a single message.
 * Tools output in parallel (no substantive text between them) are collected
 * into separate search and read/list groups, even when interleaved.
 * Substantive text or non-collapsible tools flush both groups.
 */
export function collapseToolGroups(
  blocks: Array<{ type: string; toolName?: string;[key: string]: unknown }>,
): Array<{ type: string;[key: string]: unknown } | CollapsedGroup> {
  const result: Array<{ type: string;[key: string]: unknown } | CollapsedGroup> = [];
  let searchTools: ToolUseBlock[] = [];
  let readTools: ToolUseBlock[] = [];
  /** Track which group appeared first for output ordering. */
  let firstGroup: 'search' | 'read' | null = null;

  function buildGroup(tools: ToolUseBlock[], groupType: 'search' | 'read'): CollapsedGroup | null {
    if (tools.length === 0) return null;
    if (tools.length === 1) {
      result.push(tools[0] as unknown as { type: string;[key: string]: unknown });
      return null;
    }

    let searchCount = 0;
    let readCount = 0;
    let listCount = 0;
    const searchHints: string[] = [];
    let readHint = '';
    let isActive = false;

    for (const block of tools) {
      if (block.toolName === 'grep' || block.toolName === 'glob') {
        searchCount++;
        const hint = getSearchHint(block);
        if (hint) searchHints.push(hint);
      } else if (block.toolName === 'read') {
        readCount++;
        const hint = getReadHint(block);
        if (hint) readHint = hint;
      } else if (block.toolName === 'bash') {
        const cmd = (block.input.command as string) ?? '';
        const detected = detectBashCommandType(cmd);
        if (detected.isSearch) {
          searchCount++;
          const hint = getSearchHint(block);
          if (hint) searchHints.push(hint);
        }
        if (detected.isList) {
          listCount++;
          const hint = getReadHint(block);
          if (hint) readHint = hint;
        }
      }
      if (block.state === 'executing' || block.state === 'pending') {
        isActive = true;
      }
    }

    const latestHint = groupType === 'search'
      ? searchHints.join(', ')
      : readHint;

    return {
      type: groupType,
      blocks: tools,
      searchCount,
      readCount,
      listCount,
      latestHint,
      isActive,
    } as unknown as CollapsedGroup;
  }

  function flushAll() {
    // Output in first-occurrence order
    const searchFirst = firstGroup === 'search';
    const groups: Array<{ tools: ToolUseBlock[]; type: 'search' | 'read' }> = searchFirst
      ? [{ tools: searchTools, type: 'search' as const }, { tools: readTools, type: 'read' as const }]
      : [{ tools: readTools, type: 'read' as const }, { tools: searchTools, type: 'search' as const }];

    for (const { tools, type } of groups) {
      const cg = buildGroup(tools, type);
      if (cg) result.push(cg as unknown as { type: string;[key: string]: unknown });
    }

    searchTools = [];
    readTools = [];
    firstGroup = null;
  }

  for (const block of blocks) {
    if (block.type !== 'tool_use') {
      // Whitespace-only text/thinking is transparent — don't break the batch
      if (block.type === 'text' || block.type === 'thinking') {
        const content = (block as { content?: string }).content ?? '';
        if (content.trim() === '') continue;
      }
      flushAll();
      result.push(block);
      continue;
    }

    const tu = block as unknown as ToolUseBlock;

    if (isSearchBlock(tu)) {
      if (firstGroup === null) firstGroup = 'search';
      searchTools.push(tu);
    } else if (isReadBlock(tu).isRead || isReadBlock(tu).isList) {
      if (firstGroup === null) firstGroup = 'read';
      readTools.push(tu);
    } else {
      // Non-collapsible tool: flush both groups and pass through
      flushAll();
      result.push(block);
    }
  }

  flushAll();
  return result;
}
