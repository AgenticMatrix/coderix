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
    return pattern.length > 60 ? pattern.slice(0, 57) + '...' : pattern;
  }
  if (block.toolName === 'glob') {
    const pattern = (block.input.pattern as string) ?? '';
    return pattern.length > 60 ? pattern.slice(0, 57) + '...' : pattern;
  }
  if (block.toolName === 'bash') {
    const cmd = (block.input.command as string) ?? '';
    const cleaned = '$ ' + cmd.replace(/\s+/g, ' ').trim();
    return cleaned.length > 80 ? cleaned.slice(0, 77) + '...' : cleaned;
  }
  return '';
}

function getReadHint(block: ToolUseBlock): string {
  if (block.toolName === 'read') {
    const fp = (block.input.file_path as string) ?? '';
    return fp.length > 60 ? '...' + fp.slice(-57) : fp;
  }
  if (block.toolName === 'bash') {
    const cmd = (block.input.command as string) ?? '';
    const cleaned = '$ ' + cmd.replace(/\s+/g, ' ').trim();
    return cleaned.length > 80 ? cleaned.slice(0, 77) + '...' : cleaned;
  }
  return '';
}

/**
 * Groups consecutive search/read tool_use blocks within a single message.
 * Non-matching blocks break the group and pass through unchanged.
 */
export function collapseToolGroups(
  blocks: Array<{ type: string; toolName?: string;[key: string]: unknown }>,
): Array<{ type: string;[key: string]: unknown } | CollapsedGroup> {
  const result: Array<{ type: string;[key: string]: unknown } | CollapsedGroup> = [];
  let group: ToolUseBlock[] = [];

  function flushGroup() {
    if (group.length === 0) return;
    if (group.length === 1) {
      result.push(group[0] as unknown as { type: string;[key: string]: unknown });
      group = [];
      return;
    }

    let searchCount = 0;
    let readCount = 0;
    let listCount = 0;
    let latestHint = '';
    let isActive = false;

    for (const block of group) {
      if (block.toolName === 'grep' || block.toolName === 'glob') {
        searchCount++;
        latestHint = getSearchHint(block);
      } else if (block.toolName === 'read') {
        readCount++;
        latestHint = getReadHint(block);
      } else if (block.toolName === 'bash') {
        const cmd = (block.input.command as string) ?? '';
        const detected = detectBashCommandType(cmd);
        if (detected.isSearch) searchCount++;
        if (detected.isList) listCount++;
        if (detected.isSearch) {
          latestHint = getSearchHint(block);
        } else if (detected.isList) {
          latestHint = getReadHint(block);
        }
      }
      if (block.state === 'executing' || block.state === 'pending') {
        isActive = true;
      }
    }

    // Determine group type: if there are search tools, it's search; otherwise read
    const groupType: 'search' | 'read' = searchCount > 0 ? 'search' : 'read';

    result.push({
      type: groupType === 'search' ? 'search' : 'read',
      blocks: group,
      searchCount,
      readCount,
      listCount,
      latestHint,
      isActive,
    } as unknown as { type: string;[key: string]: unknown });

    group = [];
  }

  for (const block of blocks) {
    if (block.type !== 'tool_use') {
      flushGroup();
      result.push(block);
      continue;
    }

    const tu = block as unknown as ToolUseBlock;
    const readResult = isReadBlock(tu);

    if (isSearchBlock(tu)) {
      // Search block: starts or continues a search group
      // But if current group has read blocks, flush first
      if (group.length > 0) {
        const firstRead = isReadBlock(group[0]);
        if (firstRead.isRead && !isSearchBlock(group[0])) {
          flushGroup();
        }
      }
      group.push(tu);
    } else if (readResult.isRead || readResult.isList) {
      // Read/list block: starts or continues a read group
      if (group.length > 0 && isSearchBlock(group[0])) {
        // Current group is search, read blocks can't join
        flushGroup();
      }
      group.push(tu);
    } else {
      // Non-collapsible tool: flush group and pass through
      flushGroup();
      result.push(block);
    }
  }

  flushGroup();
  return result;
}
