/**
 * /memory — View/manage Memory
 *
 * Usage:
 *   /memory              Show interactive memory picker (Claude Code style)
 *   /memory status       Show memory system status
 *   /memory view <name>  Show detail for a specific memory file
 *   /memory clean        Remove stale index entries
 */

import { join } from 'path';
import type { SlashCommand } from '../types.js';
import {
  loadIndex,
  cleanStaleEntries,
  parseMemoryFile,
  scanMemoryFiles,
  loadMemoryConfig,
  getMemoryDir,
} from '../../memory/index.js';

const TYPE_LABELS: Record<string, string> = {
  user: '[user]',
  feedback: '[feedback]',
  project: '[project]',
  reference: '[reference]',
};

function typeBadge(t: string): string {
  return TYPE_LABELS[t] ?? `[${t}]`;
}

export const memoryCommand: SlashCommand = {
  name: 'memory',
  aliases: ['mem'],
  help: 'View/manage Memory (no arg: interactive picker, status|view <name>|clean)',
  usage: '/memory [status|view <name>|clean]',

  run(arg, ctx) {
    const trimmed = arg.trim();
    const parts = trimmed.split(/\s+/);
    const sub = parts[0] || '';

    if (!sub) {
      ctx.dispatch({ type: 'SHOW_MEMORY_PICKER' });
      return;
    }

    if (sub === 'status') {
      void (async () => {
        try {
          const config = loadMemoryConfig();
          const { entries, lineCount, byteCount } = await loadIndex();
          const memDir = getMemoryDir();
          const headers = await scanMemoryFiles(memDir);

          const lines: string[] = [
            '── Memory System Status ──',
            '',
            `Enabled:      ${config.enabled ? 'yes' : 'no'}`,
            `Auto-extract: ${config.autoExtract ? 'yes' : 'no'} (every ${config.extractEveryNTurns} turns)`,
            `Recall:       ${config.recallEnabled ? 'yes' : 'no'} (max ${config.recallMaxResults} results)`,
            `Stale after:  ${config.stalenessThresholdDays} days`,
            '',
            `Memory dir:   ${memDir}`,
            `Index:        ${entries.length} entries (${lineCount} lines, ${byteCount} bytes)`,
            `Files:        ${headers.length}`,
            '',
          ];

          const typeCounts: Record<string, number> = {};
          for (const h of headers) {
            const t = h.type ?? 'unknown';
            typeCounts[t] = (typeCounts[t] || 0) + 1;
          }
          if (Object.keys(typeCounts).length > 0) {
            lines.push('By type:');
            for (const [t, n] of Object.entries(typeCounts)) {
              lines.push(`  ${typeBadge(t)}: ${n}`);
            }
            lines.push('');
          }

          if (!config.enabled) {
            lines.push('Enable with CODERIX_MEMORY_ENABLED=true or {"memory":{"enabled":true}} in settings.json.');
          }

          ctx.sys(lines.join('\n'));
        } catch (err) {
          ctx.sys(`Error: ${(err as Error).message}`);
        }
      })();
      return;
    }

    if (sub === 'view' && parts.length >= 2) {
      const name = parts[1];
      void (async () => {
        try {
          const memDir = getMemoryDir();

          let filePath = join(memDir, name.endsWith('.md') ? name : `${name}.md`);

          const { entries } = await loadIndex();
          const matched = entries.find(
            e => e.name === name || e.path === name || e.path === `${name}.md`,
          );
          if (matched) {
            filePath = join(memDir, matched.path);
          }

          const parsed = await parseMemoryFile(filePath);
          if (!parsed) {
            ctx.sys(
              `Memory "${name}" not found.\n\n` +
                `Tried: ${filePath}\n` +
                `Use /memory to browse all memories.`,
            );
            return;
          }

          const fm = parsed.frontmatter;
          const lines: string[] = [
            `── ${fm.name} ──`,
            '',
            `Description: ${fm.description}`,
            `Type:        ${fm.type}`,
          ];

          if (fm.metadata) {
            for (const [key, value] of Object.entries(fm.metadata)) {
              lines.push(`  ${key}: ${value}`);
            }
          }

          lines.push(
            `File:        ${parsed.filePath}`,
            '',
            '── Content ──',
            parsed.body,
          );

          ctx.sys(lines.join('\n'));
        } catch (err) {
          ctx.sys(`Error: ${(err as Error).message}`);
        }
      })();
      return;
    }

    if (sub === 'view') {
      ctx.sys('Usage: /memory view <name>\nExample: /memory view use-bun-not-npm');
      return;
    }

    if (sub === 'clean') {
      void (async () => {
        try {
          const removed = await cleanStaleEntries();
          if (removed === 0) {
            ctx.sys('No stale entries. MEMORY.md index is up to date.');
          } else {
            ctx.sys(`Removed ${removed} stale entr${removed === 1 ? 'y' : 'ies'} (pointing to deleted files).`);
          }
        } catch (err) {
          ctx.sys(`Error: ${(err as Error).message}`);
        }
      })();
      return;
    }

    ctx.sys(
      [
        'Usage:',
        '  /memory                Open interactive Memory picker',
        '  /memory status         Show system status',
        '  /memory view <name>    Show memory detail',
        '  /memory clean          Remove stale index entries',
      ].join('\n'),
    );
  },
};
