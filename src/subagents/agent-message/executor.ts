import type { ToolExecutor, ToolResult } from '../../tools/types.js';
import type { Message, ContentBlock } from '../../core/types.js';
import { ToolRegistry } from '../../core/tool-registry.js';
import { PermissionEngine } from '../../core/permission.js';
import { PermissionMode } from '../../core/types.js';
import { SessionManager } from '../../core/session.js';
import { CheckpointManager } from '../../core/checkpoint.js';
import { filterToolsForAgent, type SubagentType } from '../../subagents/tool-filtering.js';
import { SystemPromptAssembler } from '../../core/system-prompt.js';
import { query } from '../../core/query.js';

const MAX_RESUME_TURNS = 15;
const CONTEXT_BUDGET = 120_000;
const MAX_CONCURRENCY = 8;

function compressTranscript(messages: Message[]): string {
  const parts: string[] = [];
  for (const msg of messages.slice(-20)) {
    if (msg.role !== 'assistant') continue;
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    for (const block of blocks) {
      if (block.type === 'text') {
        const text = (block as { text?: string }).text ?? '';
        if (text) parts.push(text.slice(0, 800));
      }
    }
  }
  const body = parts.join('\n\n');
  if (!body) return '(sub-agent produced no text output)';
  if (body.length <= 2000) return body;
  return body.slice(0, 1997) + '...';
}

export const execute: ToolExecutor = async (input, options): Promise<ToolResult> => {
  const agentSpawn = options.agentSpawn;
  if (!agentSpawn) {
    return { content: 'agent-message requires agentSpawn context.', isError: true };
  }

  const agentId = input.agent_id as string;
  const message = input.message as string;

  if (!agentId || !message) {
    return { content: 'Both agent_id and message are required.', isError: true };
  }

  const registry = agentSpawn.subAgentRegistry;
  const agent = registry.get(agentId);

  if (!agent) {
    return {
      content: `Sub-agent not found: ${agentId}. Use agent-read with list_all=true to see available agents.`,
      isError: true,
    };
  }

  if (agent.status === 'running') {
    return {
      content: `Cannot message running agent ${agentId}. Wait for it to complete, or use agent-stop to cancel it first.`,
      isError: true,
    };
  }

  const transcript = agent.transcript ?? [];
  const agentType = agent.agentType as SubagentType;

  // Build the resumed conversation: original transcript + new user message
  const resumedMessages: Message[] = [
    ...transcript,
    { role: 'user', content: message },
  ];

  // Recreate sub-agent tooling (same as agent-spawn)
  const parentDefs = agentSpawn.toolRegistry.getDefinitions();
  const filteredDefs = filterToolsForAgent(parentDefs, agentType);
  const subToolRegistry = new ToolRegistry();
  for (const def of filteredDefs) {
    const registration = agentSpawn.toolRegistry.get(def.name);
    if (registration) {
      subToolRegistry.register(def, registration.execute);
    }
  }

  const subPermissionEngine = new PermissionEngine(process.cwd());
  subPermissionEngine.setMode(PermissionMode.AUTO);

  const subSessionManager = new SessionManager();
  const subSession = subSessionManager.create({
    title: `Sub-agent: ${agentType} (resumed)`,
    cwd: process.cwd(),
  });

  const subCheckpointManager = new CheckpointManager();

  const workerAssembler = new SystemPromptAssembler();
  const workerPrompt = await workerAssembler.assemble({
    cwd: process.cwd(),
    permissionMode: 'auto',
    agentRole: 'worker',
  });

  const subAbortController = new AbortController();
  registry.update(agentId, {
    status: 'running',
    abortController: subAbortController,
  });

  const startTime = Date.now();
  let assistantTurnCount = 0;
  let toolCount = 0;
  const newTranscript: Message[] = [];

  try {
    const generator = query({
      sessionId: subSession.id,
      cwd: process.cwd(),
      messages: resumedMessages,
      systemPrompt: workerPrompt,
      toolRegistry: subToolRegistry,
      permissionEngine: subPermissionEngine,
      sessionManager: subSessionManager,
      checkpointManager: subCheckpointManager,
      abortController: subAbortController,
      maxTurns: MAX_RESUME_TURNS,
      contextBudget: CONTEXT_BUDGET,
      compactThreshold: 0.7,
      maxToolConcurrency: MAX_CONCURRENCY,
      callModel: agentSpawn.callModel,
      hookManager: agentSpawn.hookManager,
    });

    for await (const msg of generator) {
      if (subAbortController.signal.aborted) break;

      switch (msg.type) {
        case 'assistant': {
          assistantTurnCount++;
          const assistantMsg = msg.message as unknown as Message;
          newTranscript.push(assistantMsg);
          const blocks = Array.isArray(assistantMsg.content) ? assistantMsg.content : [];
          toolCount += blocks.filter((b: ContentBlock) => b.type === 'tool_use').length;
          break;
        }
        case 'user':
          newTranscript.push(msg.message as unknown as Message);
          break;
        case 'system':
          if (msg.subtype === 'progress') {
            registry.update(agentId, {
              turnCount: agent.turnCount + assistantTurnCount,
              messageCount: transcript.length + newTranscript.length,
              toolCount: agent.toolCount + toolCount,
            });
          }
          break;
      }
    }

    const result = compressTranscript(newTranscript);

    registry.update(agentId, {
      status: subAbortController.signal.aborted ? 'stopped' : 'done',
      finishedAt: Date.now(),
      turnCount: agent.turnCount + assistantTurnCount,
      messageCount: transcript.length + newTranscript.length,
      toolCount: agent.toolCount + toolCount,
      result,
      transcript: [...transcript, ...newTranscript],
    });

    return {
      content: `Sub-agent ${agentId} (${agentType}) resumed and completed. +${assistantTurnCount} LLM turns, +${toolCount} tools.\n\n${result}`,
      isError: false,
      duration: Date.now() - startTime,
      metadata: {
        agentId,
        agentType,
        resumed: true,
        turnCount: assistantTurnCount,
        toolCount,
        totalTurns: agent.turnCount + assistantTurnCount,
        duration: Date.now() - startTime,
      },
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);

    registry.update(agentId, {
      status: 'error',
      finishedAt: Date.now(),
      turnCount: agent.turnCount + assistantTurnCount,
      error: errorMsg,
    });

    return {
      content: `Sub-agent ${agentId} (${agentType}) resume error after ${assistantTurnCount} turns: ${errorMsg}`,
      isError: true,
      duration: Date.now() - startTime,
      metadata: { agentId, agentType, error: errorMsg },
    };
  }
};
