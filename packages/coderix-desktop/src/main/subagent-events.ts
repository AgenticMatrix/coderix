/**
 * subagent-events.ts — Canonical sub-agent event normalization.
 *
 * Every agent engine surfaces sub-agents differently:
 *
 *   - the in-process Coderix engine runs sub-agents in a `SubAgentRegistry` and
 *     emits `agent_register` / `agent_update` events keyed by its *internal*
 *     agent id (`sub-…`, `fork-…`);
 *   - the Claude Code engine streams the sub-agent's messages inline with
 *     `parent_tool_use_id` set to the spawning tool call's id.
 *
 * The renderer, however, only ever knows a sub-agent through the main
 * conversation's `Agent`/`Task` tool call: its side pane is opened from that
 * tool card, so it can only correlate sub-agent events by the tool call's
 * `tool_use_id`. That id is therefore the **canonical identity**:
 *
 *     canonicalAgentId = toolUseId ?? engineAgentId
 *
 * Every engine must funnel its sub-agent events through `normalizeSubAgentEvent`
 * before they reach the renderer. A new engine only has to satisfy two rules:
 *
 *   1. tag each event with its internal agent id (the record's stable id, used
 *      as the on-disk transcript key), and
 *   2. attach the spawning tool call's `tool_use_id` as `agent.toolUseId`
 *      whenever the sub-agent was spawned by a tool call.
 *
 * The claude-code engine needs no conversion: its internal id *is* the
 * `tool_use_id`, so both ids coincide. The Coderix engine's `SubAgentRecord`
 * already carries `toolUseId` for every spawn path except resume, which the
 * executor now populates too.
 */

/** A raw sub-agent lifecycle event as produced by an engine. */
export interface RawSubAgentEvent {
  type: 'agent_register' | 'agent_update' | 'agent_remove';
  /** The engine's internal agent id (stable; on-disk transcript key). */
  agentId: string;
  /** Sanitized record. `toolUseId` carries the spawner tool_use id when known. */
  agent?: Record<string, unknown>;
  /** Explicit spawner tool_use id, for events that carry no record (agent_remove). */
  toolUseId?: string;
}

/** The shape forwarded to the renderer. */
export interface RendererSubAgentEvent {
  type: RawSubAgentEvent['type'];
  /** Canonical correlation id the renderer keys sub-agent state on. */
  agentId: string;
  agent?: Record<string, unknown>;
}

/**
 * Resolve the canonical correlation id for a sub-agent.
 *
 * Prefers the spawning tool call's `tool_use_id`; falls back to the engine's
 * internal id for sub-agents that were not spawned by a tool call (e.g. an
 * agent created programmatically).
 */
export function canonicalSubAgentId(
  engineAgentId: string,
  toolUseId?: string | null,
): string {
  return toolUseId || engineAgentId;
}

/**
 * Normalize a raw engine sub-agent event into the renderer's canonical shape.
 * The record's `id` is left untouched so the renderer can still resolve the
 * on-disk transcript by engine id; only the event's correlation key changes.
 */
export function normalizeSubAgentEvent(raw: RawSubAgentEvent): RendererSubAgentEvent {
  const toolUseId =
    raw.toolUseId ??
    (typeof raw.agent?.toolUseId === 'string' ? raw.agent.toolUseId : undefined);
  if (raw.type === 'agent_remove') {
    return { type: raw.type, agentId: canonicalSubAgentId(raw.agentId, toolUseId) };
  }
  return {
    type: raw.type,
    agentId: canonicalSubAgentId(raw.agentId, toolUseId),
    agent: raw.agent,
  };
}
