import type { ToolExecutor, ToolResult } from '../../../tools/types.js';
import type { Message, ContentBlock } from '../../../core/types.js';
import type { SystemPrompt } from '../../../core/system-prompt.js';
import { ToolRegistry } from '../../../core/tool-registry.js';
import { PermissionEngine } from '../../../core/permission.js';
import { PermissionMode } from '../../../core/types.js';
import { SessionManager } from '../../../core/session.js';
import { CheckpointManager } from '../../../core/checkpoint.js';
import { filterToolsForAgent } from '../../../agents/tool-filtering.js';
import { query } from '../../../core/query.js';
import { loadTeamConfig } from '../../team-store.js';
import { sendMessage } from '../../team-mailbox.js';

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

// ── Team messaging mode ──────────────────────────────────────────────

async function handleTeamMessage(input: Record<string, unknown>): Promise<ToolResult> {
  const teamName = input.team_name as string;
  const to = input.to as string;
  const text = input.text as string;
  const from = (input.from as string) || 'coordinator';

  const config = await loadTeamConfig(teamName);
  if (!config) {
    return {
      content: `Team '${teamName}' not found. Use TeamCreate to create it first.`,
      isError: true,
    };
  }

  if (to === '*') {
    let sent = 0;
    for (const member of config.members) {
      try {
        await sendMessage(teamName, from, member.name, text);
        sent++;
      } catch {
        // Skip unreachable members
      }
    }
    return {
      content: `Broadcast message sent to ${sent}/${config.members.length} member(s) in '${teamName}'.`,
      isError: false,
      metadata: { teamName, broadcast: true, recipientCount: sent },
    };
  }

  const recipient = config.members.find(m => m.name === to);
  if (!recipient) {
    const available = config.members.map(m => m.name).join(', ');
    return {
      content: `Member '${to}' not found in team '${teamName}'. Available: ${available}`,
      isError: true,
    };
  }

  await sendMessage(teamName, from, to, text);

  return {
    content: `Message sent to ${to} in team '${teamName}'.`,
    isError: false,
    metadata: { teamName, to },
  };
}

// ── Sub-agent resume mode ────────────────────────────────────────────

async function handleSubAgentResume(
  input: Record<string, unknown>,
  options: { agentSpawn?: { subAgentRegistry: { get(id: string): any; update(id: string, patch: any): void }; agentRegistry?: { get(type: string): any }; toolRegistry: ToolRegistry; callModel: any; hookManager: any } },
): Promise<ToolResult> {
  const agentSpawn = options.agentSpawn;
  if (!agentSpawn) {
    return { content: 'SendMessage sub-agent resume requires agentSpawn context.', isError: true };
  }

  const agentId = input.agent_id as string;
  const message = input.message as string;

  if (!agentId || !message) {
    return { content: 'Both agent_id and message are required for sub-agent resume mode.', isError: true };
  }

  const registry = agentSpawn.subAgentRegistry;
  const agent = registry.get(agentId);

  if (!agent) {
    return {
      content: `Sub-agent '${agentId}' not found. Use TaskGet to list available agents.`,
      isError: true,
    };
  }

  if (agent.status === 'running') {
    return {
      content: `Cannot message running agent '${agentId}'. Wait for it to complete, or use TaskStop to cancel it first.`,
      isError: true,
    };
  }

  const transcript = agent.transcript ?? [];
  const agentType = agent.agentType;
  const agentDef = agentSpawn.agentRegistry?.get(agentType);

  const resumedMessages: Message[] = [
    ...transcript,
    { role: 'user', content: message },
  ];

  // Recreate sub-agent tooling
  const parentDefs = agentSpawn.toolRegistry.getDefinitions();
  const filteredDefs = agentDef
    ? filterToolsForAgent(parentDefs, agentDef)
    : parentDefs;
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

  const systemPromptText = agentDef?.getSystemPrompt() ?? [
    'You are a sub-agent worker spawned by Coderix to complete a specific task.',
    'Complete the task efficiently using the tools available to you.',
    'You CANNOT spawn additional sub-agents.',
    'Do not ask the user questions -- you operate autonomously.',
  ].join('\n');

  const workerPrompt: SystemPrompt = {
    prompt: systemPromptText,
    parts: [{ name: `agent-${agentType}`, content: systemPromptText, priority: 0 }],
  };

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
        agentId, agentType, resumed: true,
        turnCount: assistantTurnCount, toolCount,
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
}

// ── Main executor ───────────────────────────────────────────────────

export const execute: ToolExecutor = async (input, options): Promise<ToolResult> => {
  const hasAgentId = !!(input.agent_id as string);
  const hasTeamName = !!(input.team_name as string);

  if (hasAgentId && hasTeamName) {
    return {
      content: 'Provide either agent_id (sub-agent resume) or team_name (team messaging), not both.',
      isError: true,
    };
  }

  if (hasAgentId) {
    return handleSubAgentResume(input, options as any);
  }

  if (hasTeamName) {
    return handleTeamMessage(input);
  }

  return {
    content: 'SendMessage requires either agent_id + message (sub-agent resume) or team_name + to + text (team messaging).',
    isError: true,
  };
};
