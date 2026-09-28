import type { TrajectoryCall, TrajectoryWorkRow } from './trajectoryTypes';

/** Extract the searchable plain text for a work row (thinking/tool content). */
export function rowSearchableText(row: TrajectoryWorkRow): string {
  return row.blocks
    .map((b) => {
      if (b.type === 'thinking' || b.type === 'tool_result' || b.type === 'text') {
        return b.content ?? '';
      }
      if (b.type === 'tool_use') {
        return [b.toolName ?? '', JSON.stringify(b.toolInput ?? ''), b.toolResult ?? ''].join(' ');
      }
      return '';
    })
    .join(' ');
}

/**
 * Find the set of work-row keys whose searchable text matches the query
 * (case- and whitespace-insensitive). These are the rows inside the collapsed
 * "已工作" region that must be force-expanded before DOM highlighting runs.
 * User input and the final answer are always visible, so they need no expansion.
 */
export function buildTrajectorySearchIndex(
  calls: TrajectoryCall[],
  query: string,
): { matchingRowKeys: Set<string> } {
  const matchingRowKeys = new Set<string>();
  const q = normalizeQuery(query);
  if (!q) return { matchingRowKeys };

  for (const call of calls) {
    for (const row of call.workRows) {
      if (normalizeQuery(rowSearchableText(row)).includes(q)) {
        matchingRowKeys.add(row.key);
      }
    }
  }
  return { matchingRowKeys };
}

function normalizeQuery(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}
