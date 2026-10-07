import React, { useEffect, useMemo, useState } from 'react';
import { Bot, X, Clock, CheckCircle2, XCircle, Loader2, Square, ChevronDown } from 'lucide-react';
import { useSubagentStore } from '../../store/subagentStore.js';
import { useChatStore } from '../../store/chatStore.js';
import type { SubagentSummary } from '../../ipc-client.js';
import type { StreamBlock } from '../../types.js';
import { loadSubagentTranscript } from '../../ipc-client.js';
import { useT, type TranslationKey } from '../../i18n/index.js';
import { resolveSubagentColor, parseAgentId } from './AgentToolCallCard';
import { coreMessagesToChatMessages } from './coreMessagesToChat';
import { TrajectoryCallCard } from './trajectory/TrajectoryCallCard';
import { buildTrajectoryCalls } from './trajectory/trajectoryTypes';
import type { TrajectoryCall } from './trajectory/trajectoryTypes';

/**
 * SubagentPane — a dedicated right-hand column (rendered inside AppLayout's
 * resizable column shell) showing the sub-agent conversation(s) with a tab bar
 * to switch between them. The active tab renders its full conversation with the
 * same trajectory cards as the main agent (user prompt → collapsible "已工作"
 * region → final answer); live transcript arrives via agent_* events, with an
 * on-disk fallback for cold sessions.
 */

function statusMeta(status: SubagentSummary['status'] | undefined): {
  icon: React.ReactNode;
  labelKey: TranslationKey;
  className: string;
} {
  switch (status) {
    case 'running':
      return { icon: <Loader2 size={12} className="animate-spin" />, labelKey: 'tool.running', className: 'text-[var(--color-info)]' };
    case 'done':
      return { icon: <CheckCircle2 size={12} />, labelKey: 'tool.done', className: 'text-[var(--color-success)]' };
    case 'error':
      return { icon: <XCircle size={12} />, labelKey: 'tool.error', className: 'text-[var(--color-danger)]' };
    case 'stopped':
      return { icon: <Square size={12} />, labelKey: 'tool.agent.stopped', className: 'text-[var(--color-text-tertiary)]' };
    default:
      return { icon: <Clock size={12} />, labelKey: 'tool.pending', className: 'text-[var(--color-text-tertiary)]' };
  }
}

function statusDot(status: SubagentSummary['status'] | undefined): React.ReactNode {
  const cls =
    status === 'running'
      ? 'bg-[var(--color-info)]'
      : status === 'done'
        ? 'bg-[var(--color-success)]'
        : status === 'error'
          ? 'bg-[var(--color-danger)]'
          : 'bg-[var(--color-text-tertiary)]';
  return <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${cls}`} />;
}

function truncate(text: string, max = 16): string {
  if (!text) return '';
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}

/** Convert a raw transcript (core Message[]) into trajectory calls, stamping the
 *  first/last message with the agent's real start/end so the "已工作" header
 *  reflects wall-clock duration. */
function transcriptToCalls(
  transcript: unknown[],
  agent?: SubagentSummary,
): TrajectoryCall[] {
  const msgs: unknown[] = Array.isArray(transcript) ? transcript : [];
  // The claude-code sub-agent transcript starts with the assistant turns (the
  // sub-agent's prompt lives on the Task tool input, not the transcript), so
  // prepend it as the "user message" to mirror the main agent's trajectory
  // (user → 已工作 → answer). The coderix transcript already starts with the
  // user prompt, so this only fires when the first message isn't user.
  const first = msgs[0] as { role?: string } | undefined;
  const withPrompt =
    agent?.prompt && first?.role !== 'user'
      ? [{ role: 'user', content: agent.prompt }, ...msgs]
      : msgs;
  const chatMsgs = coreMessagesToChatMessages(withPrompt);
  if (chatMsgs.length > 0 && agent) {
    if (typeof agent.createdAt === 'number') {
      chatMsgs[0] = { ...chatMsgs[0], timestamp: agent.createdAt };
    }
    if (typeof agent.finishedAt === 'number') {
      chatMsgs[chatMsgs.length - 1] = { ...chatMsgs[chatMsgs.length - 1], timestamp: agent.finishedAt };
    }
  }
  // While the agent is running, pin the last call as streaming so the header
  // reads "正在工作…" instead of a frozen "已工作".
  return buildTrajectoryCalls(chatMsgs, null, agent?.status === 'running');
}

export function SubagentPane(): React.ReactElement | null {
  const tabs = useSubagentStore((s) => s.tabs);
  const activeAgentId = useSubagentStore((s) => s.activeAgentId);
  const agents = useSubagentStore((s) => s.agents);
  const selectTab = useSubagentStore((s) => s.selectTab);
  const closeTab = useSubagentStore((s) => s.closeTab);
  const close = useSubagentStore((s) => s.close);
  const open = useSubagentStore((s) => s.open);
  const t = useT();

  const activeTab = tabs.find((tab) => tab.agentId === activeAgentId) ?? null;
  const agent = activeAgentId ? agents[activeAgentId] : undefined;
  const parentSessionId = activeTab?.parentSessionId ?? null;

  // Total sub-agent count for the current conversation — count the Agent/Task
  // tool_use blocks in the viewed session's transcript (independent of how many
  // tabs the user has opened).
  const messages = useChatStore((s) => s.messages);
  const isSubagentTool = (name?: string): boolean => {
    const n = name?.toLowerCase();
    return n === 'agent' || n === 'task';
  };
  const subagentList = useMemo(
    () =>
      messages.flatMap((m) =>
        m.blocks.filter((b) => b.type === 'tool_use' && isSubagentTool(b.toolName)),
      ),
    [messages],
  );
  const totalSubagents = subagentList.length;

  // Whether the "子智能体" dropdown (list of all sub-agents in this conversation)
  // is open.
  const [showList, setShowList] = useState(false);

  const openSubagentFromList = (block: StreamBlock): void => {
    if (!block.toolId) return;
    const inp = block.toolInput ?? {};
    const agentTypeRaw = inp.agent_type ?? inp.subagent_type;
    const agentType =
      typeof agentTypeRaw === 'string' && agentTypeRaw.trim() ? agentTypeRaw.trim() : undefined;
    const description = typeof inp.description === 'string' ? inp.description.trim() : '';
    const prompt = typeof inp.prompt === 'string' ? inp.prompt.trim() : '';
    const status: SubagentSummary['status'] =
      block.state === 'done' ? 'done' : block.state === 'error' ? 'error' : 'running';
    open(
      block.toolId,
      {
        // Engine id (on-disk transcript key) differs from the tool_use id for
        // the coderix engine; recover it from the result string when present.
        id: parseAgentId(block.toolResult) ?? block.toolId,
        toolUseId: block.toolId,
        agentType: agentType ?? 'subagent',
        description: description || undefined,
        prompt: prompt || undefined,
        result: block.toolResult || undefined,
        status,
      },
      useChatStore.getState().sessionId,
    );
    setShowList(false);
  };

  // Live transcript (from agent_update events) is authoritative while present —
  // it updates reactively per turn, so the conversation renders in real time.
  const liveTranscript = agent?.transcript;
  const liveCalls = useMemo(
    () =>
      Array.isArray(liveTranscript) && liveTranscript.length > 0
        ? transcriptToCalls(liveTranscript, agent)
        : null,
    [liveTranscript, agent?.createdAt, agent?.finishedAt, agent?.status],
  );

  // Cold sessions have no agent_* events, so no live transcript — fall back to
  // loading the on-disk JSONL once.
  const [diskCalls, setDiskCalls] = useState<TrajectoryCall[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (liveCalls) {
      setDiskCalls(null);
      setLoading(false);
      return;
    }
    if (!activeAgentId || !parentSessionId) {
      setDiskCalls(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    // Load by the engine's stable id (the record's `id`), not the canonical
    // correlation key the tab is keyed by — the coderix engine stores its
    // transcript under the internal `sub-…`/`fork-…` id.
    loadSubagentTranscript(agent?.id ?? activeAgentId, parentSessionId)
      .then((transcript) => {
        if (cancelled) return;
        if (Array.isArray(transcript) && transcript.length > 0) {
          setDiskCalls(transcriptToCalls(transcript, agent));
        } else {
          setDiskCalls([]);
        }
      })
      .catch(() => setDiskCalls([]))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeAgentId, agent?.id, parentSessionId, liveCalls]);

  const meta = statusMeta(agent?.status);
  const calls = liveCalls ?? diskCalls ?? [];
  const hasTranscript = calls.length > 0;

  return (
    <div className="h-full flex flex-col bg-[var(--color-bg-secondary)]">
            {/* Header — title + total count + tabs, one row */}
            <div className="flex items-center gap-1.5 px-2 h-11 flex-shrink-0 border-b border-[var(--color-separator)] overflow-x-auto">
              <button
                type="button"
                onClick={() => setShowList((v) => !v)}
                title={t('tool.agent.paneLabel')}
                className="flex items-center gap-1.5 flex-shrink-0 rounded-[var(--radius-sm)] px-1.5 py-1 hover:bg-[var(--color-bg-tertiary)] transition-colors"
              >
                <Bot size={15} className="text-[var(--color-text-tertiary)]" />
                <span className="text-xs font-medium text-[var(--color-text-primary)]">
                  {t('tool.agent.paneLabel')}
                </span>
                <span className="text-[11px] text-[var(--color-text-tertiary)]">
                  {totalSubagents}
                </span>
                <ChevronDown size={13} className="text-[var(--color-text-tertiary)]" />
              </button>
              <span className="w-px h-4 bg-[var(--color-separator)] flex-shrink-0 mx-1" />
              {tabs.map((tab) => {
                const a = agents[tab.agentId];
                const active = tab.agentId === activeAgentId;
                const color = resolveSubagentColor(a?.agentType ?? 'subagent');
                const label = a?.description || truncate(a?.prompt || a?.agentType || 'subagent');
                return (
                  <div
                    key={tab.agentId}
                    className={`flex items-center flex-shrink-0 max-w-[160px] rounded-[var(--radius-sm)] ${
                      active
                        ? 'bg-[var(--color-bg-tertiary)]'
                        : 'hover:bg-[var(--color-bg-tertiary)]'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => selectTab(tab.agentId)}
                      className="flex items-center gap-1.5 px-2 py-1 text-xs min-w-0"
                    >
                      {statusDot(a?.status)}
                      {a?.agentType && (
                        <span className="flex-shrink-0 font-mono text-[11px] font-medium" style={{ color }}>
                          {a.agentType}
                        </span>
                      )}
                      <span className="truncate text-[var(--color-text-secondary)]">{label}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => closeTab(tab.agentId)}
                      title={t('common.close')}
                      aria-label={t('common.close')}
                      className="w-5 h-5 mr-1 flex-shrink-0 flex items-center justify-center rounded-[var(--radius-xs)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-quaternary)] transition-colors"
                    >
                      <X size={11} />
                    </button>
                  </div>
                );
              })}
              <span className="flex-1 min-w-2" />
              <button
                type="button"
                onClick={close}
                title={t('common.close')}
                aria-label={t('common.close')}
                className="w-7 h-7 flex-shrink-0 flex items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
              >
                <X size={15} />
              </button>
            </div>

            {/* Sub-agent list — all sub-agents in this conversation, shown inline
                below the header (not as a separate overlay). Clicking one adds
                it as a tab in the header above. */}
            {showList && (
              <div className="flex-shrink-0 max-h-72 overflow-y-auto border-b border-[var(--color-separator)]">
                {subagentList.length === 0 ? (
                  <div className="p-4 text-xs text-[var(--color-text-tertiary)]">{t('common.loading')}</div>
                ) : (
                  subagentList.map((block) => {
                    const inp = block.toolInput ?? {};
                    const agentTypeRaw = inp.agent_type ?? inp.subagent_type;
                    const agentType =
                      typeof agentTypeRaw === 'string' && agentTypeRaw.trim()
                        ? agentTypeRaw.trim()
                        : undefined;
                    const description =
                      typeof inp.description === 'string' ? inp.description.trim() : '';
                    const prompt = typeof inp.prompt === 'string' ? inp.prompt.trim() : '';
                    const color = resolveSubagentColor(agentType ?? 'subagent');
                    const label = description || truncate(prompt || agentType || 'subagent');
                    const status: SubagentSummary['status'] =
                      block.state === 'done' ? 'done' : block.state === 'error' ? 'error' : 'running';
                    const isOpen = tabs.some((t) => t.agentId === block.toolId);
                    return (
                      <button
                        key={block.toolId}
                        type="button"
                        onClick={() => openSubagentFromList(block)}
                        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-left hover:bg-[var(--color-bg-tertiary)] transition-colors"
                      >
                        {statusDot(status)}
                        {agentType && (
                          <span className="flex-shrink-0 font-mono text-[11px] font-medium" style={{ color }}>
                            {agentType}
                          </span>
                        )}
                        <span className="flex-1 min-w-0 truncate text-[var(--color-text-secondary)]">{label}</span>
                        {isOpen && (
                          <span className="text-[10px] text-[var(--color-text-tertiary)] flex-shrink-0">✓</span>
                        )}
                      </button>
                    );
                  })
                )}
              </div>
            )}

            {/* Body */}
            <div className="flex-1 overflow-y-auto">
              {agent && (
                <div className="px-4 py-2 border-b border-[var(--color-separator)] flex items-center gap-2">
                  <span className={`flex items-center gap-1 text-[11px] font-medium ${meta.className}`}>
                    {meta.icon}
                    <span>{t(meta.labelKey)}</span>
                  </span>
                  {(agent.turnCount !== undefined || agent.toolCount !== undefined) && (
                    <span className="text-[11px] text-[var(--color-text-tertiary)]">
                      {t('tool.agent.stats', { turns: agent.turnCount ?? 0, tools: agent.toolCount ?? 0 })}
                    </span>
                  )}
                </div>
              )}

              {loading && (
                <div className="p-4 text-xs text-[var(--color-text-tertiary)]">{t('session.loading')}</div>
              )}

              {!loading && hasTranscript && (
                <div className="px-3 py-3 space-y-4">
                  {calls.map((call) => (
                    <TrajectoryCallCard key={call.key} call={call} />
                  ))}
                </div>
              )}

              {!loading && !hasTranscript && (
                <div className="p-4 text-xs text-[var(--color-text-tertiary)]">
                  {t('session.loading')}
                </div>
              )}
            </div>
    </div>
  );
}

SubagentPane.displayName = 'SubagentPane';
