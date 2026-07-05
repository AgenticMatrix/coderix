import { h } from 'preact';
import { useState } from 'preact/hooks';
import type { SubagentState } from '../app';

export interface SubagentTreeProps {
  subagents: Map<string, SubagentState>;
}

const statusConfig: Record<SubagentState['status'], { label: string; className: string }> = {
  running: { label: 'Running', className: 'subagent-status--running' },
  completed: { label: 'Done', className: 'subagent-status--completed' },
  error: { label: 'Error', className: 'subagent-status--error' },
  interrupted: { label: 'Stopped', className: 'subagent-status--interrupted' },
};

function SubagentCard({ agent }: { agent: SubagentState }): h.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const cfg = statusConfig[agent.status];

  const progressPct = agent.taskCount && agent.taskIndex !== undefined
    ? Math.round((agent.taskIndex / agent.taskCount) * 100)
    : undefined;

  return (
    <div class="subagent-card">
      <button class="subagent-card-header" onClick={() => setExpanded(!expanded)}>
        <span class={`subagent-status ${cfg.className}`}>{cfg.label}</span>
        <span class="subagent-goal">{agent.goal}</span>
        {agent.currentTool && (
          <span class="subagent-tool">Running: {agent.currentTool}</span>
        )}
        <span class={`subagent-expand-arrow ${expanded ? 'expanded' : ''}`}>▼</span>
      </button>

      {progressPct !== undefined && (
        <div class="subagent-progress-bar">
          <div class="subagent-progress-fill" style={{ width: `${progressPct}%` }} />
        </div>
      )}

      {expanded && (
        <div class="subagent-card-details">
          {agent.durationSeconds !== undefined && (
            <span class="subagent-detail">Duration: {agent.durationSeconds.toFixed(1)}s</span>
          )}
          {agent.tokensUsed !== undefined && (
            <span class="subagent-detail">Tokens: {agent.tokensUsed.toLocaleString()}</span>
          )}
          {agent.filesRead && agent.filesRead.length > 0 && (
            <div class="subagent-files">
              <span class="subagent-detail-label">Files read:</span>
              {agent.filesRead.map((f) => (
                <code class="subagent-file" key={f}>{f}</code>
              ))}
            </div>
          )}
          {agent.filesWritten && agent.filesWritten.length > 0 && (
            <div class="subagent-files">
              <span class="subagent-detail-label">Files written:</span>
              {agent.filesWritten.map((f) => (
                <code class="subagent-file" key={f}>{f}</code>
              ))}
            </div>
          )}
          {agent.summary && (
            <div class="subagent-summary">{agent.summary}</div>
          )}
        </div>
      )}
    </div>
  );
}

export function SubagentTree({ subagents }: SubagentTreeProps): h.JSX.Element {
  if (subagents.size === 0) return <div />;

  const entries = Array.from(subagents.values());

  return (
    <div class="subagent-tree">
      {entries.map((agent) => (
        <SubagentCard key={agent.agentId} agent={agent} />
      ))}
    </div>
  );
}

SubagentTree.displayName = 'SubagentTree';
