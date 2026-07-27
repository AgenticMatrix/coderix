import type { ToolExecutor, ToolResult } from '../../../tools/types.js';
import type { Message, ContentBlock, AgentSpawnContext } from '../../../core/types.js';
import type { SystemPrompt } from '../../../core/system-prompt.js';
import { ToolRegistry } from '../../../core/tool-registry.js';
import { PermissionEngine } from '../../../core/permission.js';
import { PermissionMode } from '../../../core/types.js';
import { SessionManager } from '../../../core/session.js';
import { CheckpointManager } from '../../../core/checkpoint.js';
import { filterToolsForResumedAgent, GLOBAL_DISALLOWED_FOR_SUBAGENTS } from '../../../agents/tool-filtering.js';
import { query } from '../../../core/query.js';
import { loadTeamConfig, listTeams } from '../../team-store.js';
import { sendMessage } from '../../team-mailbox.js';
import {
  findAgentOnDisk,
  saveAgentTranscript,
  writeAgentMetadata,
} from '../../../agents/agent-persistence.js';
import type { DiskAgentInfo } from '../../../agents/agent-persistence.js';
import { sessionDir as getSessionDir } from '../../../core/session-store.js';
import { truncateToTokenLimit, countTokens } from '../../../core/token-counter.js';

const MAX_RESUME_TURNS = 200;
const CONTEXT_BUDGET = 120_000;
const MAX_CONCURRENCY = 8;

function compressTranscript(messages: Message[]): string {
  const parts: string[] = [];
  for (const msg of messages.slice(-60)) {
    if (msg.role !== 'assistant') continue;
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    for (const block of blocks) {
      if (block.type === 'text') {
        const text = (block as { text?: string }).text ?? '';
        if (text) parts.push(truncateToTokenLimit(text, 4000));
      }
    }
  }
  const body = parts.join('\n\n');
  if (!body) return '(sub-agent produced no text output)';
  if (countTokens(body) <= 8000) return body;
  return truncateToTokenLimit(body, 8000);
}

interface ToolCallSummary {
  name: string;
  input: string;
  state: string;
}

function extractToolCalls(messages: Message[]): ToolCallSummary[] {
  const tools: ToolCallSummary[] = [];
  for (const msg of messages.slice(-50)) {
    if (msg.role !== 'assistant') continue;
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    for (const block of blocks) {
      if (block.type === 'tool_use') {
        const b = block as { name?: string; input?: Record<string, unknown>; id?: string };
        const inputStr = b.input ? JSON.stringify(b.input) : '';
        tools.push({ name: b.name ?? 'unknown', input: inputStr, state: 'done' });
      }
    }
  }
  return tools;
}

function trimTranscriptForResume(messages: Message[]): Message[] {
  const MAX_TOOL_OUTPUT = 4000;
  return messages.map((msg) => {
    if (msg.role !== 'user') return msg;
    const blocks = Array.isArray(msg.content) ? msg.content as ContentBlock[] : [];
    const hasLargeOutput = blocks.some(
      (b) => b.type === 'tool_result' && typeof (b as { content?: string }).content === 'string'
        && ((b as { content?: string }).content?.length ?? 0) > MAX_TOOL_OUTPUT,
    );
    if (!hasLargeOutput) return msg;
    return {
      ...msg,
      content: blocks.map((b) => {
        if (b.type !== 'tool_result') return b;
        const content = (b as { content?: unknown }).content;
        if (typeof content === 'string' && content.length > MAX_TOOL_OUTPUT) {
          return {
            ...b,
            content: content.slice(0, MAX_TOOL_OUTPUT)
              + `\n... [trimmed ${content.length - MAX_TOOL_OUTPUT} chars]`,
          };
        }
        return b;
      }),
    };
  });
}

// ── Team member index (name ↔ agentId) ─────────────────────────────────

interface TeamMemberIndex {
  byId: Map<string, string>;
  byName: Map<string, string>;
}

async function buildTeamMemberIndex(sessionDir: string | undefined): Promise<TeamMemberIndex> {
  const byId = new Map<string, string>();
  const byName = new Map<string, string>();
  if (!sessionDir) return { byId, byName };
  try {
    const teams = await listTeams(sessionDir);
    for (const t of teams) {
      const cfg = await loadTeamConfig(sessionDir, t);
      if (!cfg) continue;
      for (const m of cfg.members) {
        byId.set(m.agentId, m.name);
        byName.set(m.name, m.agentId);
      }
    }
  } catch { /* best-effort */ }
  return { byId, byName };
}

// ── Auto-resume a stopped agent ──────────────────────────────────────

async function resumeAgent(
  agentId: string,
  agentType: string,
  transcript: Message[],
  text: string,
  agentSpawn: AgentSpawnContext,
  diskInfo: DiskAgentInfo | null,
  memberIndex: TeamMemberIndex,
  parentSessionDir: string,
): Promise<ToolResult> {
  const registry = agentSpawn.subAgentRegistry;
  const agentDef = agentSpawn.agentRegistry?.get(agentType);

  const trimmedTranscript = trimTranscriptForResume(transcript);
  const resumedMessages: Message[] = [
    ...trimmedTranscript,
    { role: 'user', content: text },
  ];

  // Build sub-agent tooling
  const parentDefs = agentSpawn.toolRegistry.getDefinitions();
  const filteredDefs = agentDef
    ? filterToolsForResumedAgent(parentDefs, agentDef)
    : parentDefs.filter(t => !GLOBAL_DISALLOWED_FOR_SUBAGENTS.has(t.name));
  const subToolRegistry = new ToolRegistry();
  for (const def of filteredDefs) {
    const registration = agentSpawn.toolRegistry.get(def.name);
    if (registration) {
      subToolRegistry.register(def, registration.execute);
    }
  }

  // Restore team SendMessage wrapper
  const isTeamAgent = !!(diskInfo?.teamName);
  const resumeAgentName = diskInfo?.memberName || memberIndex.byId.get(agentId);
  if (isTeamAgent && resumeAgentName && parentSessionDir) {
    const teamMsgReg = agentSpawn.toolRegistry.get('SendMessage');
    if (teamMsgReg) {
      subToolRegistry.register(
        {
          name: 'SendMessage',
          description: teamMsgReg.definition.description,
          input_schema: teamMsgReg.definition.input_schema,
          riskLevel: teamMsgReg.definition.riskLevel ?? 'safe' as any,
        },
        async (toolInput: Record<string, unknown>, ctx: any) => {
          const result = await teamMsgReg.execute(
            { ...toolInput, from: resumeAgentName, _teamSessionDir: parentSessionDir },
            { cwd: ctx.cwd ?? process.cwd(), sessionId: ctx.sessionId } as any,
          );
          return {
            content: result.content,
            isError: result.isError,
            duration: result.duration,
            metadata: { ...(result.metadata ?? {}), fromName: resumeAgentName },
          };
        },
      );
    }
  }

  const subPermissionEngine = new PermissionEngine(process.cwd());
  subPermissionEngine.setMode(PermissionMode.AUTO);

  const subSessionManager = new SessionManager(true);
  const subSession = subSessionManager.create({
    title: `Sub-agent: ${agentType} (resumed)`,
    cwd: process.cwd(),
    parentSessionId: agentSpawn.sessionManager.getActive()?.id,
  });

  const subCheckpointManager = new CheckpointManager();

  // Build system prompt
  let systemPromptText: string;
  if (diskInfo?.systemPrompt) {
    systemPromptText = diskInfo.systemPrompt;
  } else if (agentDef && agentSpawn.systemPromptAssembler) {
    try {
      const workerPrompt = await agentSpawn.systemPromptAssembler.assemble({
        cwd: process.cwd(),
        permissionMode: 'auto',
        agentRole: 'worker',
      });
      const envPart = workerPrompt.parts.find(p => p.name === 'env_info');
      const permPart = workerPrompt.parts.find(p => p.name === 'permission_mode');
      const extra = [envPart?.content, permPart?.content].filter(Boolean).join('\n\n');
      systemPromptText = extra
        ? agentDef.getSystemPrompt() + '\n\n' + extra
        : agentDef.getSystemPrompt();
    } catch {
      systemPromptText = agentDef.getSystemPrompt();
    }
  } else {
    systemPromptText = agentDef?.getSystemPrompt() ?? [
      'You are a sub-agent worker spawned by Coderix to complete a specific task.',
      'Complete the task efficiently using the tools available to you.',
      'You CANNOT spawn additional sub-agents.',
      'Do not ask the user questions — you operate autonomously.',
    ].join('\n');
  }

  const workerPrompt: SystemPrompt = {
    prompt: systemPromptText,
    parts: [{ name: `agent-${agentType}`, content: systemPromptText, priority: 0 }],
  };

  const subAbortController = new AbortController();
  registry.update(agentId, {
    status: 'running',
    abortController: subAbortController,
  });

  if (diskInfo?.teamName && parentSessionDir) {
    const { updateMemberInTeam } = await import('../../../utils/swarm/teamHelpers.js');
    updateMemberInTeam(parentSessionDir, diskInfo.teamName, agentId, { status: 'running' }).catch(() => {});
  }

  const startTime = Date.now();
  let assistantTurnCount = 0;
  let toolCount = 0;
  const newTranscript: Message[] = [];
  const accumulatedLiveCalls: ToolCallSummary[] = [];

  const RESUMED_TIMEOUT_MS = 10 * 60 * 1000;

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
      maxTurns: agentDef?.maxTurns ?? MAX_RESUME_TURNS,
      contextBudget: agentDef?.contextBudget ?? CONTEXT_BUDGET,
      compactThreshold: 0.85,
      maxToolConcurrency: MAX_CONCURRENCY,
      callModel: agentSpawn.callModel,
      hookManager: agentSpawn.hookManager,
      subAgentRegistry: agentSpawn.subAgentRegistry,
      agentRole: 'worker',
    });

    const timeoutPromise = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), RESUMED_TIMEOUT_MS),
    );

    let timedOut = false;
    const result = await Promise.race([
      (async () => {
        for await (const msg of generator) {
          if (subAbortController.signal.aborted) break;
          switch (msg.type) {
            case 'assistant': {
              assistantTurnCount++;
              const assistantMsg = msg.message as unknown as Message;
              newTranscript.push(assistantMsg);
              const blocks = Array.isArray(assistantMsg.content) ? assistantMsg.content : [];
              for (const block of blocks) {
                if (block.type === 'tool_use') {
                  const b = block as { name?: string; input?: Record<string, unknown>; id?: string };
                  const inputStr = b.input ? JSON.stringify(b.input) : '';
                  accumulatedLiveCalls.push({ name: b.name ?? 'unknown', input: inputStr, state: 'executing' });
                  toolCount++;
                }
              }
              break;
            }
            case 'user':
              newTranscript.push(msg.message as unknown as Message);
              break;
            case 'system':
              if (msg.subtype === 'progress') {
                registry.update(agentId, {
                  turnCount: (registry.get(agentId)?.turnCount ?? 0) + assistantTurnCount,
                  messageCount: transcript.length + newTranscript.length,
                  toolCount: (registry.get(agentId)?.toolCount ?? 0) + toolCount,
                  liveToolCalls: [...accumulatedLiveCalls],
                });
              }
              break;
          }
        }
      })(),
      timeoutPromise,
    ]);

    if (result === 'timeout') {
      subAbortController.abort();
      timedOut = true;
    }

    const cumulativeTranscript = [...transcript, { role: 'user' as const, content: text }, ...newTranscript];
    const resultText = timedOut
      ? `(timed out after ${RESUMED_TIMEOUT_MS / 1000}s)`
      : compressTranscript(newTranscript);

    const baseTurnCount = registry.get(agentId)?.turnCount ?? 0;
    const baseToolCount = registry.get(agentId)?.toolCount ?? 0;

    const finalStatus = subAbortController.signal.aborted ? 'stopped' : 'done';
    registry.update(agentId, {
      status: finalStatus,
      finishedAt: Date.now(),
      turnCount: baseTurnCount + assistantTurnCount,
      messageCount: cumulativeTranscript.length,
      toolCount: baseToolCount + toolCount,
      result: resultText,
      transcript: cumulativeTranscript,
    });

    if (parentSessionDir) {
      saveAgentTranscript(agentId, cumulativeTranscript, parentSessionDir).catch(() => {});
      writeAgentMetadata(agentId, {
        agentType, worktreePath: undefined, description: '',
        createdAt: registry.get(agentId)?.createdAt ?? Date.now(), finishedAt: Date.now(),
      }, parentSessionDir).catch(() => {});
      if (diskInfo?.teamName) {
        const { updateMemberInTeam } = await import('../../../utils/swarm/teamHelpers.js');
        updateMemberInTeam(parentSessionDir, diskInfo.teamName, agentId, {
          status: finalStatus,
          finishedAt: Date.now(),
        }).catch(() => {});
      }
    }

    const agentDisplayName = memberIndex.byId.get(agentId);

    return {
      content: `Sub-agent ${agentId} (${agentType}) resumed and completed. +${assistantTurnCount} LLM turns, +${toolCount} tools.\n\n${resultText}`,
      isError: false,
      duration: Date.now() - startTime,
      metadata: {
        agentId, agentType, resumed: true,
        agentName: agentDisplayName,
        turnCount: assistantTurnCount, toolCount,
        totalTurns: baseTurnCount + assistantTurnCount,
        duration: Date.now() - startTime,
        toolCalls: extractToolCalls(newTranscript),
      },
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    registry.update(agentId, {
      status: 'error',
      finishedAt: Date.now(),
      turnCount: (registry.get(agentId)?.turnCount ?? 0) + assistantTurnCount,
      error: errorMsg,
    });
    if (diskInfo?.teamName && parentSessionDir) {
      const { updateMemberInTeam } = await import('../../../utils/swarm/teamHelpers.js');
      updateMemberInTeam(parentSessionDir, diskInfo.teamName, agentId, {
        status: 'error',
        finishedAt: Date.now(),
      }).catch(() => {});
    }
    return {
      content: `Sub-agent ${agentId} (${agentType}) resume error after ${assistantTurnCount} turns: ${errorMsg}`,
      isError: true,
      duration: Date.now() - startTime,
      metadata: { agentId, agentType, agentName: memberIndex.byId.get(agentId), error: errorMsg },
    };
  }
}

// ── Legacy internal resume (non-team sub-agents) ─────────────────────
// Used by query-engine.sendSubAgentMessage, not exposed to the model.

async function handleLegacySubAgentResume(
  agentId: string,
  message: string,
  options: Record<string, unknown>,
): Promise<ToolResult> {
  const agentSpawn = (options as any).agentSpawn as AgentSpawnContext | undefined;
  if (!agentSpawn) {
    return { content: 'SendMessage sub-agent resume requires agentSpawn context.', isError: true };
  }

  const registry = agentSpawn.subAgentRegistry;
  const parentSessionId = agentSpawn.sessionManager.getActive()?.id;
  const parentSessionDir = parentSessionId ? getSessionDir(parentSessionId) : undefined;
  let agent = registry.get(agentId);
  let diskInfo: DiskAgentInfo | null = null;

  if (!agent) {
    if (!parentSessionDir) {
      return { content: 'No active session directory available for disk fallback.', isError: true };
    }
    diskInfo = await findAgentOnDisk(agentId, parentSessionDir);
    if (!diskInfo) {
      return {
        content: `Agent '${agentId}' not found in registry or on disk. Use TaskGet to list available agents.`,
        isError: true,
      };
    }

    const diskAbortController = new AbortController();
    registry.register({
      id: agentId,
      name: `${diskInfo.meta.agentType}-${agentId}`,
      agentType: (diskInfo.meta.agentType as any) || 'general-purpose',
      status: 'stopped',
      prompt: diskInfo.meta.description ?? '',
      createdAt: diskInfo.meta.createdAt,
      turnCount: diskInfo.transcript.filter((m: Message) => m.role === 'assistant').length,
      messageCount: diskInfo.transcript.length,
      toolCount: 0,
      abortController: diskAbortController,
      notified: true,
      transcript: diskInfo.transcript,
    });
    agent = registry.get(agentId);
    if (!agent) {
      return { content: `Failed to re-register agent '${agentId}' from disk.`, isError: true };
    }
  }

  if (agent.status === 'running') {
    return {
      content: `Cannot message running agent '${agentId}'. Wait for it to complete, or use TaskStop to cancel it first.`,
      isError: true,
    };
  }

  // Delegate to the unified resume function
  const memberIndex = await buildTeamMemberIndex(parentSessionDir);
  return resumeAgent(
    agentId,
    agent.agentType,
    agent.transcript ?? [],
    message,
    agentSpawn,
    diskInfo,
    memberIndex,
    parentSessionDir ?? '',
  );
}

// ── Main executor ───────────────────────────────────────────────────

export const execute: ToolExecutor = async (input, options): Promise<ToolResult> => {
  // ── Backward-compatible internal path: agent_id + message (non-team sub-agents) ─
  // Used by query-engine.sendSubAgentMessage for resuming regular (non-team)
  // sub-agents via the TUI bridge. Not exposed in the model-facing schema.
  const legacyAgentId = input.agent_id as string | undefined;
  const legacyMessage = input.message as string | undefined;
  if (legacyAgentId && legacyMessage) {
    return handleLegacySubAgentResume(legacyAgentId, legacyMessage, options);
  }

  const agentName = input.agent_name as string;
  const teamName = input.team_name as string;
  const text = input.text as string | undefined;
  const from = (input.from as string) || process.env.CODERIX_AGENT_NAME || process.env.CODERIX_AGENT_ID || 'leader';
  const messageType = input.message_type as string | undefined;

  // Resolve session dir — prefer _teamSessionDir override for workers
  const teamSessionDir = input._teamSessionDir as string | undefined;
  const sessionId = options.sessionId;
  if (!teamSessionDir && !sessionId) {
    return { content: 'Error: no active session.', isError: true };
  }
  const sd = teamSessionDir || getSessionDir(sessionId!);

  if (!teamName) {
    return { content: 'team_name is required.', isError: true };
  }

  const config = await loadTeamConfig(sd, teamName);
  if (!config) {
    return {
      content: `Team '${teamName}' not found. Use TeamCreate to create it first.`,
      isError: true,
    };
  }

  // ── Structured message: shutdown_request ─────────────────────────
  if (messageType === 'shutdown_request') {
    if (!agentName) {
      return { content: 'agent_name is required for shutdown_request.', isError: true };
    }
    const { sendShutdownRequestToMailbox } = await import(
      '../../../utils/swarm/teammateMailbox.js'
    );
    const reason = (input.reason as string) || undefined;
    const result = await sendShutdownRequestToMailbox(sd, agentName, teamName, reason);
    return {
      content: `Shutdown request sent to '${agentName}' in team '${teamName}' (requestId: ${result.requestId}).`,
      isError: false,
      metadata: { teamName, agentName, messageType, requestId: result.requestId },
    };
  }

  // ── Structured message: shutdown_response ────────────────────────
  if (messageType === 'shutdown_response') {
    if (!agentName) {
      return { content: 'agent_name is required for shutdown_response.', isError: true };
    }
    const approve = input.approve as boolean;
    const reason = input.reason as string | undefined;
    const { createShutdownApprovedMessage, createShutdownRejectedMessage, writeToMailbox } =
      await import('../../../utils/swarm/teammateMailbox.js');

    const msg = approve
      ? createShutdownApprovedMessage({
          requestId: (input.request_id as string) || 'unknown',
          from,
        })
      : createShutdownRejectedMessage({
          requestId: (input.request_id as string) || 'unknown',
          from,
          reason: reason || 'Rejected by user',
        });

    await writeToMailbox(sd, agentName, {
      from,
      text: JSON.stringify(msg),
      timestamp: new Date().toISOString(),
    });

    return {
      content: approve
        ? `Shutdown approved for '${agentName}' in team '${teamName}'.`
        : `Shutdown rejected for '${agentName}' in team '${teamName}'. Reason: ${reason || 'unspecified'}`,
      isError: false,
      metadata: { teamName, agentName, messageType, approved: approve },
    };
  }

  // ── Plain text messaging — agent_name is required ─────────────────
  if (!agentName) {
    return {
      content: 'agent_name is required. Use agent_name: "<name>", agent_name: "leader", or agent_name: "*" for broadcast.',
      isError: true,
    };
  }

  if (!text) {
    return {
      content: 'text is required for plain text messages.',
      isError: true,
    };
  }

  // Resolve sender name
  const fromName = from === 'leader' ? 'leader' : (config.members.find(m => m.name === from || m.agentId === from)?.name ?? from);

  const agentSpawn = options.agentSpawn;

  // ── Broadcast ─────────────────────────────────────────────────────
  if (agentName === '*') {
    let sent = 0;
    let instantCount = 0;
    for (const member of config.members) {
      let delivered = false;
      if (agentSpawn) {
        const recipientRecord = agentSpawn.subAgentRegistry.list()
          .find(r => r.name.includes(member.name) && r.status === 'running');
        if (recipientRecord) {
          if (!recipientRecord.pendingMessages) {
            recipientRecord.pendingMessages = [];
          }
          recipientRecord.pendingMessages.push(`[${fromName} -> ${member.name}]: ${text}`);
          instantCount++;
          sent++;
          delivered = true;
        }
      }
      if (!delivered) {
        try {
          await sendMessage(sd, teamName, fromName, member.name, text);
          sent++;
        } catch {
          // Skip unreachable members
        }
      }
    }
    return {
      content: `Broadcast message sent to ${sent}/${config.members.length} worker(s) in '${teamName}'.${instantCount > 0 ? ` (${instantCount} delivered instantly)` : ''}`,
      isError: false,
      metadata: { teamName, broadcast: true, recipientCount: sent, instantCount, fromName, agentName: '*' },
    };
  }

  // ── Leader message ────────────────────────────────────────────────
  if (agentName === 'leader') {
    await sendMessage(sd, teamName, fromName, 'leader', text);
    return {
      content: `Message sent to leader in team '${teamName}'.`,
      isError: false,
      metadata: { teamName, agentName: 'leader', fromName },
    };
  }

  // ── Unicast: resolve recipient by name (primary) or agentId (fallback) ─
  const member = config.members.find(m => m.name === agentName) ?? config.members.find(m => m.agentId === agentName);
  if (!member) {
    const available = config.members.map(m => m.name).join(', ');
    return {
      content: `Agent '${agentName}' not found in team '${teamName}'. Available: leader, ${available}. Use TeamAgent to create a new worker first.`,
      isError: true,
    };
  }

  const resolvedName = member.name;
  const resolvedId = member.agentId;

  // ── Check registry for running agent → deliver message ────────────
  if (agentSpawn) {
    const runningRecord = agentSpawn.subAgentRegistry.list()
      .find(r => r.name.includes(resolvedName) && r.status === 'running');
    if (runningRecord) {
      // In-memory fast path
      if (!runningRecord.pendingMessages) {
        runningRecord.pendingMessages = [];
      }
      runningRecord.pendingMessages.push(`[${fromName} -> ${resolvedName}]: ${text}`);
      return {
        content: `Message delivered instantly to ${resolvedName} in team '${teamName}'.`,
        isError: false,
        metadata: { teamName, agentName: resolvedName, fromName, instant: true },
      };
    }
  }

  // Write to inbox for running agents not in the in-memory registry
  await sendMessage(sd, teamName, fromName, resolvedName, text);

  // ── Check if agent is stopped → auto-resume ───────────────────────
  const registry = agentSpawn?.subAgentRegistry;
  let stoppedRecord = registry?.get(resolvedId);
  let diskInfo: DiskAgentInfo | null = null;

  if (!stoppedRecord || stoppedRecord.status === 'running') {
    // Agent is running (message delivered above) or not in registry at all
    if (!stoppedRecord) {
      // Check if the message arrived at a running agent outside our registry
      // (e.g. different process). Just return "sent".
      return {
        content: `Message sent to ${resolvedName} in team '${teamName}'.`,
        isError: false,
        metadata: { teamName, agentName: resolvedName, fromName },
      };
    }
    // Running agent — message already delivered above
    return {
      content: `Message sent to ${resolvedName} in team '${teamName}'.`,
      isError: false,
      metadata: { teamName, agentName: resolvedName, fromName },
    };
  }

  // Agent is stopped/done/error in registry — auto-resume (unless the
  // agent is still alive in its poll loop waiting for messages).
  if (!stoppedRecord._alive && (stoppedRecord.status === 'done' || stoppedRecord.status === 'stopped' || stoppedRecord.status === 'error')) {
    const transcript = stoppedRecord.transcript ?? [];

    // Try to get diskInfo for team context restoration
    const parentSessionDir = sd;
    const memberIndex = await buildTeamMemberIndex(parentSessionDir);
    diskInfo = await findAgentOnDisk(resolvedId, parentSessionDir);

    const formattedText = `[Team messages]\n[${fromName} -> ${resolvedName}]: ${text}`;

    return resumeAgent(
      resolvedId,
      member.agentType,
      transcript,
      formattedText,
      agentSpawn!,
      diskInfo,
      memberIndex,
      parentSessionDir,
    );
  }

  return {
    content: `Message sent to ${resolvedName} in team '${teamName}'.`,
    isError: false,
    metadata: { teamName, agentName: resolvedName, fromName },
  };
};
