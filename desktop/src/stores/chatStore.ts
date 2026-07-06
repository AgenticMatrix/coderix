/**
 * chatStore.ts — Central chat state management (replaces TUI useChatReducer).
 *
 * Manages: messages, streaming state, input text, tool execution state,
 * permission prompts, and all chat-related UI state.
 */

import { create } from 'zustand';

// ── Types ─────────────────────────────────────────────────────────

export interface TextBlock {
  type: 'text';
  content: string;
}

export interface ThinkingBlock {
  type: 'thinking';
  content: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  toolName: string;
  toolId: string;
  input: Record<string, unknown>;
  state: 'pending' | 'executing' | 'done' | 'error';
  result?: {
    content: string;
    isError: boolean;
    metadata?: Record<string, unknown>;
  };
  duration?: number;
}

export interface ToolResultBlock {
  type: 'tool_result';
  toolId: string;
  toolName: string;
  content: string;
  isError: boolean;
  duration?: number;
  metadata?: Record<string, unknown>;
}

export type MessageBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock;

export interface ChatMessage {
  id: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  blocks: MessageBlock[];
  thinking?: string;
  timestamp: number;
  tokenUsage?: TokenUsage;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface ApprovalRequest {
  toolName: string;
  command: string;
  description: string;
  requestId: string;
}

export interface PendingQuestion {
  toolName: string;
  toolUseId: string;
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect: boolean;
  }>;
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface ChatState {
  // Messages
  messages: ChatMessage[];
  streamingMessageId: number | null;

  // Input
  inputText: string;

  // Status
  isStreaming: boolean;
  statusText: string;
  error: string | null;
  connectionStatus: ConnectionStatus;

  // Session
  sessionId: string;

  // Streamed blocks (being built)
  activeBlocks: Map<string, MessageBlock>;

  // Permission
  pendingApproval: ApprovalRequest | null;
  pendingQuestion: PendingQuestion | null;

  // Token tracking
  totalTokens: TokenUsage;
  sessionCostUsd: number;

  // Sub-agents
  runningAgents: Array<{ id: string; name: string; status: string }>;

  // Actions
  setInputText: (text: string) => void;
  setConnectionStatus: (status: ConnectionStatus) => void;
  addUserMessage: (text: string) => void;
  startAssistantResponse: (id: number) => void;
  appendBlockDelta: (messageId: number, deltaType: string, text: string) => void;
  startBlock: (messageId: number, block: MessageBlock) => void;
  stopBlock: (messageId: number) => void;
  finishAssistantResponse: (id: number) => void;
  addToolResults: (blocks: MessageBlock[]) => void;
  updateToolUseResult: (toolId: string, result: { content: string; isError: boolean; metadata?: Record<string, unknown> }, duration?: number) => void;
  updateBlockState: (toolId: string, state: 'pending' | 'executing' | 'done' | 'error') => void;
  setError: (error: string) => void;
  clearError: () => void;
  setStatusText: (text: string) => void;
  showApproval: (req: ApprovalRequest) => void;
  hideApproval: () => void;
  showQuestion: (q: PendingQuestion) => void;
  hideQuestion: () => void;
  updateTokenUsage: (usage: Partial<TokenUsage>) => void;
  setSessionId: (id: string) => void;
  clearChat: () => void;
  setStreaming: (v: boolean) => void;
}

let nextId = 1;
export function nextMessageId(): number {
  return nextId++;
}

// ── Store ──────────────────────────────────────────────────────────

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  streamingMessageId: null,
  inputText: '',
  isStreaming: false,
  statusText: 'Ready',
  error: null,
  connectionStatus: 'disconnected',
  sessionId: '',
  activeBlocks: new Map(),
  pendingApproval: null,
  pendingQuestion: null,
  totalTokens: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
  sessionCostUsd: 0,
  runningAgents: [],

  setInputText: (text) => set({ inputText: text }),

  setConnectionStatus: (status) => set({ connectionStatus: status }),

  addUserMessage: (text) => {
    const msg: ChatMessage = {
      id: nextMessageId(),
      role: 'user',
      content: text,
      blocks: [{ type: 'text', content: text }],
      timestamp: Date.now(),
    };
    set((s) => ({ messages: [...s.messages, msg] }));
  },

  startAssistantResponse: (id) => {
    set({ streamingMessageId: id, isStreaming: true, error: null });
  },

  appendBlockDelta: (messageId, deltaType, text) => {
    set((s) => {
      if (s.streamingMessageId !== messageId) return s;
      // Update content of the message being built
      const msgs = [...s.messages];
      const idx = msgs.findIndex((m) => m.id === messageId);
      if (idx >= 0) {
        const existing = msgs[idx]!;
        if (deltaType === 'text') {
          msgs[idx] = { ...existing, content: existing.content + text };
        } else if (deltaType === 'thinking') {
          msgs[idx] = { ...existing, thinking: (existing.thinking ?? '') + text };
        }
      } else {
        // First delta: create the message
        const msg: ChatMessage = {
          id: messageId,
          role: 'assistant',
          content: deltaType === 'text' ? text : '',
          blocks: [],
          thinking: deltaType === 'thinking' ? text : undefined,
          timestamp: Date.now(),
        };
        msgs.push(msg);
      }
      return { messages: msgs };
    });
  },

  startBlock: (messageId, block) => {
    set((s) => {
      const activeBlocks = new Map(s.activeBlocks);
      if (block.type === 'tool_use') {
        activeBlocks.set(block.toolId, block);
      }
      // Add block to the message
      const msgs = [...s.messages];
      const idx = msgs.findIndex((m) => m.id === messageId);
      if (idx >= 0) {
        msgs[idx] = { ...msgs[idx]!, blocks: [...msgs[idx]!.blocks, block] };
      }
      return { messages: msgs, activeBlocks };
    });
  },

  stopBlock: (messageId) => {
    // No-op for now; used by the bridge to signal block completion
  },

  finishAssistantResponse: (id) => {
    set((s) => ({
      streamingMessageId: null,
      isStreaming: false,
      statusText: 'Ready',
    }));
  },

  addToolResults: (blocks) => {
    set((s) => ({
      messages: [
        ...s.messages,
        {
          id: nextMessageId(),
          role: 'system' as const,
          content: '',
          blocks,
          timestamp: Date.now(),
        },
      ],
    }));
  },

  updateToolUseResult: (toolId, result, duration) => {
    set((s) => {
      const msgs = s.messages.map((m) => {
        const updatedBlocks = m.blocks.map((b) => {
          if (b.type === 'tool_use' && b.toolId === toolId) {
            return {
              ...b,
              state: result.isError ? ('error' as const) : ('done' as const),
              result,
              duration,
            };
          }
          return b;
        });
        return { ...m, blocks: updatedBlocks };
      });
      return { messages: msgs };
    });
  },

  updateBlockState: (toolId, state) => {
    set((s) => {
      const msgs = s.messages.map((m) => {
        const updatedBlocks = m.blocks.map((b) => {
          if (b.type === 'tool_use' && b.toolId === toolId) {
            return { ...b, state };
          }
          return b;
        });
        return { ...m, blocks: updatedBlocks };
      });
      return { messages: msgs };
    });
  },

  setError: (error) => set({ error, isStreaming: false, statusText: 'Error' }),

  clearError: () => set({ error: null }),

  setStatusText: (text) => set({ statusText: text }),

  showApproval: (req) => set({ pendingApproval: req }),

  hideApproval: () => set({ pendingApproval: null }),

  showQuestion: (q) => set({ pendingQuestion: q }),

  hideQuestion: () => set({ pendingQuestion: null }),

  updateTokenUsage: (usage) =>
    set((s) => ({
      totalTokens: { ...s.totalTokens, ...usage },
    })),

  setSessionId: (id) => set({ sessionId: id }),

  clearChat: () =>
    set({
      messages: [],
      streamingMessageId: null,
      error: null,
      activeBlocks: new Map(),
    }),

  setStreaming: (v) => set({ isStreaming: v }),
}));
