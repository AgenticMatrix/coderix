import React, { useEffect, useMemo, useState } from 'react';
import { Bot, X, Clock, CheckCircle2, XCircle, Loader2, Square } from 'lucide-react';
import { useSubagentStore } from '../../store/subagentStore.js';
import type { SubagentSummary } from '../../ipc-client.js';
import { loadSubagentTranscript } from '../../ipc-client.js';
import { useT, type TranslationKey } from '../../i18n/index.js';
import { resolveSubagentColor } from './AgentToolCallCard';
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

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)]">
        {label}
      </div>
      {children}
    </div>
  );
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
  const t = useT();

  const activeTab = tabs.find((tab) => tab.agentId === activeAgentId) ?? null;
  const agent = activeAgentId ? agents[activeAgentId] : undefined;
  const parentSessionId = activeTab?.parentSessionId ?? null;

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
    loadSubagentTranscript(activeAgentId, parentSessionId)
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
  }, [activeAgentId, parentSessionId, liveCalls]);

  const meta = statusMeta(agent?.status);
  const calls = liveCalls ?? diskCalls ?? [];
  const hasTranscript = calls.length > 0;

  return (
    <div className="h-full flex flex-col bg-[var(--color-bg-secondary)]">
            {/* Header */}
            <div className="flex items-center gap-2 px-4 h-11 flex-shrink-0 border-b border-[var(--color-separator)]">
              <Bot size={15} className="text-[var(--color-text-tertiary)] flex-shrink-0" />
              <span className="text-xs font-medium text-[var(--color-text-primary)] flex-shrink-0">
                {t('tool.agent.label')}
              </span>
              <span className="text-[11px] text-[var(--color-text-tertiary)] flex-shrink-0">
                {tabs.length}
              </span>
              <span className="flex-1" />
              <button
                type="button"
                onClick={close}
                title={t('common.close')}
                aria-label={t('common.close')}
                className="w-7 h-7 flex items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
              >
                <X size={15} />
              </button>
            </div>

            {/* Tab bar */}
            <div className="flex items-stretch overflow-x-auto flex-shrink-0 border-b border-[var(--color-separator)]">
              {tabs.map((tab) => {
                const a = agents[tab.agentId];
                const active = tab.agentId === activeAgentId;
                const color = resolveSubagentColor(a?.agentType ?? 'subagent');
                const label = a?.description || truncate(a?.prompt || a?.agentType || 'subagent');
                return (
                  <div
                    key={tab.agentId}
                    className={`flex items-center flex-shrink-0 max-w-[180px] border-b-2 ${
                      active
                        ? 'border-[var(--color-brand)]'
                        : 'border-transparent hover:border-[var(--color-separator-strong)]'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => selectTab(tab.agentId)}
                      className="flex items-center gap-1.5 px-2.5 py-2 text-xs min-w-0"
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
                      className="w-5 h-5 mr-1 flex-shrink-0 flex items-center justify-center rounded-[var(--radius-xs)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
                    >
                      <X size={11} />
                    </button>
                  </div>
                );
              })}
            </div>

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
                <div className="px-4 py-3 space-y-4">
                  {agent?.description && (
                    <div className="text-xs text-[var(--color-text-secondary)] leading-relaxed">
                      {agent.description}
                    </div>
                  )}

                  {agent?.prompt && (
                    <Section label={t('tool.prompt')}>
                      <pre className="p-2 rounded-[var(--radius-sm)] bg-[var(--color-bg-tertiary)] text-xs text-[var(--color-text-primary)] font-mono whitespace-pre-wrap break-all leading-[18px] m-0 max-h-48 overflow-y-auto">
                        {agent.prompt}
                      </pre>
                    </Section>
                  )}

                  {agent?.error && (
                    <Section label={t('tool.error')}>
                      <pre className="p-2 rounded-[var(--radius-sm)] bg-[var(--color-bg-tertiary)] text-xs text-[var(--color-danger)] font-mono whitespace-pre-wrap break-all leading-[18px] m-0 max-h-48 overflow-y-auto">
                        {agent.error}
                      </pre>
                    </Section>
                  )}

                  {agent?.result && (
                    <Section label={t('tool.result')}>
                      <pre className="p-2 rounded-[var(--radius-sm)] bg-[var(--color-bg-tertiary)] text-xs text-[var(--color-text-secondary)] font-mono whitespace-pre-wrap break-words leading-[18px] m-0 max-h-96 overflow-y-auto">
                        {agent.result}
                      </pre>
                    </Section>
                  )}

                  {!agent && (
                    <div className="text-xs text-[var(--color-text-tertiary)]">
                      {t('common.loading')}
                    </div>
                  )}
                </div>
              )}
            </div>
    </div>
  );
}

SubagentPane.displayName = 'SubagentPane';
