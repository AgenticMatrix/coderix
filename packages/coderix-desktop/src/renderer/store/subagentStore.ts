import { create } from 'zustand';
import type { SubagentSummary } from '../ipc-client.js';

export interface SubagentTab {
  agentId: string;
  parentSessionId: string | null;
}

export interface SubagentState {
  /** Live sub-agent summaries keyed by agent id, fed by agent_register/update events. */
  agents: Record<string, SubagentSummary>;
  /** Open sub-agent tabs (ordered), shown in the side pane tab bar. */
  tabs: SubagentTab[];
  /** The currently selected tab (null = pane closed). */
  activeAgentId: string | null;
  /** Open a sub-agent in the side pane (or focus its existing tab), optionally seeding it. */
  open: (agentId: string, seed?: Partial<SubagentSummary>, parentSessionId?: string | null) => void;
  /** Switch the active tab. */
  selectTab: (agentId: string) => void;
  /** Close one tab, activating a neighbor if it was active. */
  closeTab: (agentId: string) => void;
  /** Close the whole pane (all tabs), keeping the sub-agent records so a later
   *  session switch back can still recover their transcripts. */
  close: () => void;
  /** Apply a lifecycle event from the main process. */
  applyEvent: (
    type: 'agent_register' | 'agent_update' | 'agent_remove',
    agentId: string,
    agent?: SubagentSummary,
  ) => void;
}

/**
 * Sub-agent store — mirrors the CLI/TUI's `agents` map but with tab management
 * for the side pane. agent_register inserts, agent_update merges, agent_remove
 * deletes (and closes its tab). The Agent tool card seeds a tab on "open" so
 * the pane is never empty even before the first lifecycle event arrives.
 */
export const useSubagentStore = create<SubagentState>()((set) => ({
  agents: {},
  tabs: [],
  activeAgentId: null,

  open: (agentId, seed, parentSessionId) =>
    set((state) => {
      const exists = state.tabs.some((t) => t.agentId === agentId);
      const tabs = exists
        ? state.tabs
        : [...state.tabs, { agentId, parentSessionId: parentSessionId ?? null }];
      // Seed only fills gaps: a live record fed by agent_* events is
      // authoritative, so it must not be clobbered by the card's seed (which
      // lacks the engine's stable `id` while the tool call is still running).
      const agents = seed
        ? { ...state.agents, [agentId]: { ...seed, ...(state.agents[agentId] ?? {}) } }
        : state.agents;
      return { tabs, activeAgentId: agentId, agents };
    }),

  selectTab: (agentId) => set({ activeAgentId: agentId }),

  closeTab: (agentId) =>
    set((state) => {
      const idx = state.tabs.findIndex((t) => t.agentId === agentId);
      const tabs = state.tabs.filter((t) => t.agentId !== agentId);
      let activeAgentId = state.activeAgentId;
      if (activeAgentId === agentId) {
        const neighbor = tabs[idx] ?? tabs[tabs.length - 1] ?? null;
        activeAgentId = neighbor ? neighbor.agentId : null;
      }
      return { tabs, activeAgentId };
    }),

  close: () => set({ tabs: [], activeAgentId: null }),

  applyEvent: (type, agentId, agent) =>
    set((state) => {
      if (type === 'agent_remove') {
        const agents = { ...state.agents };
        delete agents[agentId];
        const idx = state.tabs.findIndex((t) => t.agentId === agentId);
        const tabs = state.tabs.filter((t) => t.agentId !== agentId);
        let activeAgentId = state.activeAgentId;
        if (activeAgentId === agentId) {
          const neighbor = tabs[idx] ?? tabs[tabs.length - 1] ?? null;
          activeAgentId = neighbor ? neighbor.agentId : null;
        }
        return { agents, tabs, activeAgentId };
      }
      const prev = state.agents[agentId] ?? {};
      // The completion update drops `transcript` (the core frees the in-memory
      // copy); preserve the last live snapshot so the pane keeps the full
      // conversation after the agent finishes.
      const transcript = agent?.transcript ?? prev.transcript;
      return {
        agents: { ...state.agents, [agentId]: { ...prev, ...agent, transcript } },
      };
    }),
}));
