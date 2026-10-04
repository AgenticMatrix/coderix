import React from 'react';
import { motion } from 'framer-motion';
import { Bot, Clock, CheckCircle2, XCircle, Loader2, PanelRightOpen } from 'lucide-react';
import type { StreamBlock } from '../../types';
import { useT, type TranslationKey } from '../../i18n/index.js';
import { useSubagentStore } from '../../store/subagentStore.js';
import { useChatStore } from '../../store/chatStore.js';
import type { SubagentSummary } from '../../ipc-client.js';

/**
 * AgentToolCallCard — ZCode-style sub-agent summary card.
 *
 * The `Agent` tool spawns a sub-agent; instead of the generic tool card (raw
 * key/value input + a big result blob), render a compact single-line summary:
 *   🤖 Subagent  <colored agent type>  <description>  完成 · N 轮 · M 工具
 *
 * The whole row is a button: clicking it opens the sub-agent side pane (the
 * ZCode "open on the right" affordance), seeded from the tool's input/result so
 * the pane is never empty even before the first agent_* lifecycle event.
 *
 * The agent type name is colored by a stable hash of its name (ZCode's
 * `resolveSubagentColorFromName`).
 */

const SUBAGENT_COLORS = [
  '#d97706', // amber
  '#dc2626', // red
  '#ea580c', // orange
  '#059669', // emerald
  '#0891b2', // cyan
  '#2563eb', // blue
  '#7c3aed', // violet
  '#db2777', // pink
];

export function resolveSubagentColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return SUBAGENT_COLORS[hash % SUBAGENT_COLORS.length] ?? SUBAGENT_COLORS[0]!;
}

interface AgentStats {
  turns?: number;
  tools?: number;
}

/** Structured metadata (agentId/turnCount/toolCount) wins; otherwise parse the
 *  result string's "N LLM turns, M tools used." summary line. */
function parseAgentStats(
  toolResult: string | undefined,
  toolMetadata: Record<string, unknown> | undefined,
): AgentStats {
  const turns = typeof toolMetadata?.turnCount === 'number' ? toolMetadata.turnCount : undefined;
  const tools = typeof toolMetadata?.toolCount === 'number' ? toolMetadata.toolCount : undefined;
  if (turns !== undefined || tools !== undefined) return { turns, tools };
  if (!toolResult) return {};
  const turnsMatch = toolResult.match(/(\d+)\s+(?:LLM )?turns?/i);
  const toolsMatch = toolResult.match(/(\d+)\s+tools? used/i);
  return {
    turns: turnsMatch ? Number(turnsMatch[1]) : undefined,
    tools: toolsMatch ? Number(toolsMatch[1]) : undefined,
  };
}

/** Extract the sub-agent id from the result string ("Sub-agent sub-x completed…"). */
function parseAgentId(result?: string): string | undefined {
  if (!result) return undefined;
  const m = result.match(/(?:Sub-agent|Fork agent|Background agent|agent)\s+([A-Za-z0-9_-]+)/i);
  return m?.[1];
}

function truncate(text: string, max = 60): string {
  if (!text) return '';
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}

export interface AgentToolCallCardProps {
  toolInput?: Record<string, unknown>;
  state?: StreamBlock['state'];
  toolId?: string;
  toolResult?: string;
  toolMetadata?: Record<string, unknown>;
}

export function AgentToolCallCard({
  toolInput = {},
  state = 'executing',
  toolId,
  toolResult,
  toolMetadata,
}: AgentToolCallCardProps): React.ReactElement {
  const t = useT();
  const open = useSubagentStore((s) => s.open);

  const agentTypeRaw = toolInput.agent_type ?? toolInput.subagent_type;
  const agentType =
    typeof agentTypeRaw === 'string' && agentTypeRaw.trim()
      ? agentTypeRaw.trim()
      : undefined;
  const description = typeof toolInput.description === 'string' ? toolInput.description.trim() : '';
  const prompt = typeof toolInput.prompt === 'string' ? toolInput.prompt.trim() : '';
  const background = toolInput.background === true;
  const primaryText = description || truncate(prompt, 50);
  const color = resolveSubagentColor(agentType ?? 'subagent');

  const stats = parseAgentStats(toolResult, toolMetadata);
  const isDone = state === 'done';
  const isError = state === 'error';

  const handleOpen = () => {
    // Resolve the agent id: structured metadata → result string → live event
    // matched by toolUseId → the tool_use id itself as a last resort.
    let id =
      (typeof toolMetadata?.agentId === 'string' && toolMetadata.agentId) ||
      parseAgentId(toolResult);
    if (!id && toolId) {
      const match = Object.values(useSubagentStore.getState().agents).find(
        (a) => a.toolUseId === toolId,
      );
      id = match?.id ?? toolId;
    }
    if (!id) return;

    const status: SubagentSummary['status'] =
      state === 'done' ? 'done' : state === 'error' ? 'error' : 'running';
    open(
      id,
      {
        id,
        agentType: agentType ?? 'subagent',
        description: description || undefined,
        prompt: prompt || undefined,
        result: toolResult || undefined,
        status,
        turnCount: stats.turns,
        toolCount: stats.tools,
      },
      useChatStore.getState().sessionId,
    );
  };

  const statusIcon =
    state === 'pending' ? (
      <Clock size={12} />
    ) : state === 'executing' ? (
      <Loader2 size={12} className="animate-spin" />
    ) : state === 'done' ? (
      <CheckCircle2 size={12} />
    ) : (
      <XCircle size={12} />
    );
  const statusLabelKey: TranslationKey =
    state === 'pending'
      ? 'tool.pending'
      : state === 'executing'
        ? 'tool.running'
        : state === 'done'
          ? 'tool.done'
          : 'tool.error';
  const statusClass =
    state === 'pending'
      ? 'text-[var(--color-text-tertiary)]'
      : state === 'executing'
        ? 'text-[var(--color-info)]'
        : state === 'done'
          ? 'text-[var(--color-success)]'
          : 'text-[var(--color-danger)]';

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15 }}
    >
      <motion.button
        type="button"
        onClick={handleOpen}
        title={t('tool.agent.open')}
        className="flex items-center gap-1.5 py-1 w-full text-left text-xs cursor-pointer transition-colors duration-100 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
      >
        <span className="text-[var(--color-text-tertiary)] flex-shrink-0">
          <Bot size={13} />
        </span>
        <span className="text-[var(--color-text-primary)] flex-shrink-0 font-medium">
          {t('tool.agent.label')}
        </span>
        {agentType && (
          <span className="flex-shrink-0 font-mono font-medium" style={{ color }}>
            {agentType}
          </span>
        )}
        {primaryText && (
          <span className="text-[var(--color-text-secondary)] overflow-hidden text-ellipsis whitespace-nowrap min-w-0">
            {primaryText}
          </span>
        )}
        {background && (
          <span className="flex-shrink-0 text-[var(--color-text-tertiary)]">
            {t('tool.agent.background')}
          </span>
        )}
        <span className="flex-1" />
        {isDone && (stats.turns !== undefined || stats.tools !== undefined) && (
          <span className="text-[11px] text-[var(--color-text-tertiary)] flex-shrink-0">
            {t('tool.agent.stats', { turns: stats.turns ?? 0, tools: stats.tools ?? 0 })}
          </span>
        )}
        <span className={`flex items-center gap-1 text-[11px] font-medium flex-shrink-0 ${statusClass}`}>
          {statusIcon}
          <span>{t(statusLabelKey)}</span>
        </span>
        <PanelRightOpen
          size={13}
          className="text-[var(--color-text-tertiary)] flex-shrink-0"
        />
      </motion.button>
    </motion.div>
  );
}

AgentToolCallCard.displayName = 'AgentToolCallCard';
