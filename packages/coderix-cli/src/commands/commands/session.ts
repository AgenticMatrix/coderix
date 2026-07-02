import type { SlashCommand } from '../types.js';

const streamingBusy = 'Agent is currently streaming. Wait for it to finish, then try again.';

export const sessionCommands: SlashCommand[] = [
  {
    name: 'resume',
    aliases: ['rs'],
    help: 'list previous sessions or resume one by ID',
    usage: '/resume [<session-id> | last]',
    run: (arg, ctx) => {
      if (ctx.isStreaming) {
        ctx.sys(streamingBusy);
        return;
      }

      if (!ctx.listSessions) {
        ctx.sys('Session listing is not available in this environment.');
        return;
      }

      const trimmed = arg.trim();

      if (!trimmed) {
        // ── List sessions ──
        const sessions = ctx.listSessions();
        if (sessions.length === 0) {
          ctx.sys('No previous sessions found.');
          return;
        }

        const lines: string[] = ['Recent sessions:', ''];
        for (let i = 0; i < Math.min(sessions.length, 20); i++) {
          const s = sessions[i]!;
          const updated = s.updatedAt.toISOString().split('T')[0];
          // Auto-generated titles like "Session 6cd7a6f0" are useless
          const isAuto = /^Session [0-9a-f]{8}$/.test(s.title);
          const title = isAuto ? '—' : s.title.length > 48 ? s.title.slice(0, 48) + '...' : s.title;
          const empty = s.turnCount === 0 ? ' (empty)' : '';
          lines.push(
            `  ${String(i + 1).padEnd(3)} ${s.id.slice(0, 8).padEnd(9)} ${String(s.turnCount).padStart(4)}t  ${s.model.padEnd(18)} ${updated}  ${title}${empty}`,
          );
        }
        lines.push('');
        lines.push('/resume <id>  — resume a session');
        lines.push('/resume last  — resume the most recent session');

        ctx.sys(lines.join('\n'));
        return;
      }

      // ── Resume a session ──
      if (!ctx.resumeSession) {
        ctx.sys('Session resuming is not available in this environment.');
        return;
      }

      const sessions = ctx.listSessions();

      if (trimmed === 'last') {
        try {
          ctx.resumeSession('__last__');
        } catch (e) {
          ctx.sys(`Failed to resume session: ${(e as Error).message}`);
        }
        return;
      }

      // Try matching by ID prefix or numeric index
      let targetId: string | null = null;

      // Numeric index (1-based from the list)
      const idx = parseInt(trimmed, 10);
      if (!isNaN(idx) && idx >= 1 && idx <= sessions.length) {
        targetId = sessions[idx - 1]!.id;
      } else {
        // ID prefix match
        const match = sessions.find((s) => s.id.startsWith(trimmed));
        if (match) targetId = match.id;
      }

      if (!targetId) {
        ctx.sys(`No session found matching "${trimmed}". Use /resume to list sessions.`);
        return;
      }

      try {
        ctx.resumeSession(targetId);
      } catch (e) {
        ctx.sys(`Failed to resume session: ${(e as Error).message}`);
      }
    },
  },
];
