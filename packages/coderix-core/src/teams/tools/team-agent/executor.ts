import { readdir } from 'node:fs/promises';
import type { ToolExecutor, ToolResult } from '../../../tools/types.js';
import type { Message, AgentSpawnContext, ToolContext } from '../../../core/types.js';
import type { AgentDefinition } from '../../../core/types.js';
import { ToolRegistry } from '../../../core/tool-registry.js';
import { RiskLevel } from '../../../core/types.js';
import { filterToolsForAgent } from '../../../agents/tool-filtering.js';
import { loadTeamConfig, teamDir, listTeams } from '../../team-store.js';
import { addMemberToTeam, updateMemberInTeam } from '../../../utils/swarm/teamHelpers.js';
import { drainUnreadMessages } from '../../team-mailbox.js';
import type { SwarmTeamMember } from '../../../utils/swarm/teamHelpers.js';
import teamMessagePlugin from '../team-message/index.js';
import {
  runAgentLoop,
  compressTranscript,
  extractToolCalls,
  cleanupAgentWorktree,
  shortId,
  DEFAULT_MAX_TURNS,
  DEFAULT_CONTEXT_BUDGET,
} from '../../../agents/agent-runner.js';
import {
  createAgentWorktree,
} from '../../../utils/worktree.js';
import {
  runWithAgentContext,
  createSubagentContext,
  type SubagentContext,
} from '../../../agents/agent-context.js';
import {
  isAgentMemoryEnabled,
  loadAgentMemoryPrompt,
  augmentToolsForMemory,
} from '../../../agents/agent-memory.js';
import {
  writeTeamAgentMetadata,
  saveTeamAgentTranscript,
  writeTeamAgentSystemPrompt,
} from '../../../agents/agent-persistence.js';
import { sessionDir as getSessionDir } from '../../../core/session-store.js';

const TEAMMATE_COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4',
  '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F',
  '#BB8FCE', '#85C1E9', '#F8C471', '#82E0AA',
];

export const execute: ToolExecutor = async (input, options): Promise<ToolResult> => {
  const agentSpawn = options.agentSpawn;
  if (!agentSpawn) {
    return {
      content: 'TeamAgent requires agentSpawn context.',
      isError: true,
    };
  }

  const sessionId = options.sessionId;
  if (!sessionId) {
    return { content: 'Error: no active session.', isError: true };
  }
  const sd = getSessionDir(sessionId);

  const teamName = input.team_name as string;
  const agentName = input.name as string;
  const prompt = input.prompt as string;
  const agentTypeInput = (input.agent_type as string) || 'general-purpose';
  const modelOverride = input.model as string | undefined;
  const description = input.description as string | undefined;
  const isolation = input.isolation as 'worktree' | undefined;
  const isBackground = (input.background as boolean) ?? false;

  // ── Validate team exists ────────────────────────────────────────────
  const config = await loadTeamConfig(sd, teamName);
  if (!config) {
    const dir = teamDir(sd, teamName);
    let dirContents = '(directory does not exist)';
    try {
      const entries = await readdir(dir);
      dirContents = entries.length > 0 ? entries.join(', ') : '(empty directory)';
    } catch {
      // Directory doesn't exist
    }

    const teams = await listTeams(sd);
    const available = teams.length > 0
      ? `\n\nAvailable teams: ${teams.join(', ')}`
      : '\n\nNo teams exist yet. Create one with TeamCreate.';

    return {
      content: [
        `Team '${teamName}' not found at ${dir}.`,
        `Directory contents: ${dirContents}${available}`,
        '',
        `Create it with: TeamCreate(team_name: "${teamName}", description: "...")`,
      ].join('\n'),
      isError: true,
    };
  }

  // ── Check duplicate ─────────────────────────────────────────────────
  const existing = config.members.find(m => m.name === agentName);
  if (existing && existing.status === 'running') {
    return {
      content: `Team member '${agentName}' is already running in team '${teamName}' (agentId: ${existing.agentId}). Use SendMessage to communicate with it.`,
      isError: true,
    };
  }

  // ── Look up agent definition ────────────────────────────────────────
  const agentDef = agentSpawn.agentRegistry?.get(agentTypeInput) ?? null;
  if (!agentDef) {
    const available = agentSpawn.agentRegistry?.list().map(a => a.agentType).join(', ') ?? 'none';
    return {
      content: `Unknown agent type: ${agentTypeInput}. Available: ${available}`,
      isError: true,
    };
  }

  const agentType = agentTypeInput;
  const agentId = `swarm-${shortId()}`;
  const colorIndex = Math.floor(Math.random() * TEAMMATE_COLORS.length);
  const color = TEAMMATE_COLORS[colorIndex];

  // ── Register in team file ───────────────────────────────────────────
  const member: SwarmTeamMember = {
    agentId,
    name: agentName,
    agentType: agentDef.agentType ?? agentType,
    model: modelOverride,
    color,
    status: 'running',
    prompt,
    joinedAt: Date.now(),
  };

  await addMemberToTeam(sd, teamName, member);

  // ── Build tool registry ─────────────────────────────────────────────
  const parentDefs = agentSpawn.toolRegistry.getDefinitions();
  let effectiveTools = agentDef.tools;
  if (isAgentMemoryEnabled() && agentDef.memory) {
    effectiveTools = augmentToolsForMemory(effectiveTools ?? '*');
  }
  const agentDefForFilter = effectiveTools !== agentDef.tools
    ? { ...agentDef, tools: effectiveTools }
    : agentDef;
  const filteredDefs = filterToolsForAgent(parentDefs, agentDefForFilter);
  const subToolRegistry = new ToolRegistry();
  for (const def of filteredDefs) {
    // Listen checks for sub-agent completion notifications, not team inbox
    // messages. Team agents use the built-in poll loop for communication.
    if (def.name === 'Listen') continue;
    const registration = agentSpawn.toolRegistry.get(def.name);
    if (registration) {
      subToolRegistry.register(def, registration.execute);
    }
  }

  // Register SendMessage tool for inter-team communication
  const teamMsgSchema = teamMessagePlugin.schema as unknown as { input_schema: Record<string, unknown>; description: string };
  subToolRegistry.register(
    {
      name: teamMessagePlugin.name,
      description: teamMsgSchema.description,
      input_schema: teamMsgSchema.input_schema,
      riskLevel: RiskLevel.SAFE,
    },
    async (toolInput: Record<string, unknown>, ctx: ToolContext) => {
      const result = await teamMessagePlugin.executor(
        { ...toolInput, from: agentName, _teamSessionDir: sd },
        {
          cwd: ctx.cwd ?? process.cwd(),
          allowMutation: true,
          maxOutput: 50_000,
          bashTimeout: 30_000,
          sessionId: ctx.sessionId,
        },
      );
      return {
        content: result.content,
        isError: result.isError,
        duration: result.duration,
        metadata: { ...(result.metadata ?? {}), fromName: agentName },
      };
    },
  );

  // ── Worktree isolation ──────────────────────────────────────────────
  let worktreePath: string | undefined;
  let worktreeBranch: string | undefined;
  let worktreeGitRoot: string | undefined;
  let worktreeHeadCommit: string | undefined;
  let worktreeHookBased: boolean | undefined;
  const effectiveCwd = options.cwd ?? process.cwd();

  if (isolation === 'worktree') {
    try {
      const wt = await createAgentWorktree(`team-${agentName}-${agentId}`, agentSpawn.hookManager);
      worktreePath = wt.worktreePath;
      worktreeBranch = wt.worktreeBranch;
      worktreeGitRoot = wt.gitRoot;
      worktreeHeadCommit = wt.headCommit;
      worktreeHookBased = wt.hookBased;
    } catch (err) {
      return {
        content: `Failed to create worktree for team worker: ${(err as Error).message}`,
        isError: true,
      };
    }
  }

  // ── Build system prompt ─────────────────────────────────────────────
  const userPrompt = agentDef.initialPrompt
    ? `${agentDef.initialPrompt}\n\n${prompt}`
    : prompt;

  let enrichedPrompt: string;
  if (agentSpawn.renderedSystemPrompt) {
    enrichedPrompt = agentSpawn.renderedSystemPrompt.prompt;
  } else {
    enrichedPrompt = agentDef.getSystemPrompt();
  }

  // Layer agent type's custom system prompt (additional instructions)
  const agentTypePrompt = agentDef.getSystemPrompt();
  if (agentTypePrompt) {
    enrichedPrompt = enrichedPrompt + '\n\n' + agentTypePrompt;
  }

  // Inject memory if enabled
  if (isAgentMemoryEnabled() && agentDef.memory) {
    const memoryPrompt = await loadAgentMemoryPrompt(
      agentType,
      agentDef.memory,
      worktreePath ?? process.cwd(),
    );
    if (memoryPrompt) {
      enrichedPrompt = memoryPrompt + '\n\n' + enrichedPrompt;
    }
  }

  // Inject team member addendum (identity + communication rules)
  const peerMembers = config.members.filter(m => m.agentId !== agentId);
  const peerList = peerMembers.length > 0
    ? peerMembers.map(m => `"${m.name}"`).join(', ')
    : '(none)';
  const teamCtx = [
    '',
    '# Team Communication Rules (CRITICAL — read carefully)',
    '',
    `You are **${agentName}** in team **${teamName}**.`,
    '',
    '**SendMessage is your ONLY way to communicate.** You cannot see what other',
    'members write unless they SendMessage to you. Plain text you output goes',
    'nowhere — no teammate will see it.',
    '',
    '## When you MUST use SendMessage',
    '1. **Answer direct questions** — if a teammate asks you something specific,',
    '   reply with the answer.',
    '2. **Report results to the leader** — when you finish a task, tell the leader',
    '   what happened, even if there were no issues.',
    '3. **Ask for information or help** — if you need input from a specific teammate.',
    '4. **Share new information** — when you discover or complete something your',
    '   teammates need to know about.',
    '5. **Acknowledge a task or instruction** — it is fine to confirm receipt once',
    '   when someone gives you a task or asks you a question.',
    '',
    '## When NOT to use SendMessage',
    '- Do NOT reply to an acknowledgment. If someone sends "Got it", "Standing',
    '  by", "Ready" etc., there is nothing to respond to — stay silent.',
    '- Replying to an acknowledgment creates a ping-pong loop: Alice says "Got',
    '  it", Bob says "Got it" back, Alice says "Got it" again… endlessly.',
    '- Key rule: acknowledge tasks ONCE. Do NOT acknowledge an acknowledgment.',
    '',
    '## How to send',
    `- To the leader: SendMessage(agent_name: "leader", team_name: "${teamName}", text: "<message>")`,
    `- To a peer: SendMessage(agent_name: "<name>", team_name: "${teamName}", text: "<message>")`,
    `- Broadcast to all: SendMessage(agent_name: "*", team_name: "${teamName}", text: "<message>")`,
    '',
    `Peers in this team: ${peerList || '(none)'}`,
    `Leader: "leader"`,
    '',
    '## Communication protocol',
    '- When you receive a task or question: acknowledge once, then act on it.',
    '- When you receive an acknowledgment ("Got it", "Standing by"): do NOT reply.',
    '  Acknowledging an acknowledgment starts an infinite ping-pong loop.',
    '- If asked a direct question: answer it via SendMessage.',
    '- When your task is done: report to the leader via SendMessage.',
    '- Teammates have a 30-second idle timeout — reply promptly when needed.',
    '- Do NOT assume others know your status — tell them when it matters.',
    '',
    'IMPORTANT: You do NOT need to wait or poll for messages. The system',
    'automatically delivers incoming messages to you. Just complete your',
    'current task and new messages will appear in your next turn.',
  ].join('\n');
  enrichedPrompt = enrichedPrompt + teamCtx;

  // Save system prompt to disk
  writeTeamAgentSystemPrompt(sd, teamName, agentId, enrichedPrompt);

  const initialMessages: Message[] = [
    { role: 'user', content: userPrompt },
  ];

  const effectiveModel = modelOverride ?? agentDef.model;
  const subAbortController = new AbortController();

  // ── Register in SubAgentRegistry ────────────────────────────────────
  agentSpawn.subAgentRegistry.register({
    id: agentId,
    name: `${agentName} (${teamName})`,
    agentType: agentType as 'explore' | 'plan' | 'general-purpose',
    status: 'running',
    prompt,
    description,
    createdAt: Date.now(),
    turnCount: 0,
    messageCount: 0,
    toolCount: 0,
    abortController: subAbortController,
    notified: false,
    toolUseId: options.toolUseId,
  });

  agentSpawn.sessionManager.trackSubAgent(agentId);

  const spawnTime = Date.now();

  // Capture for use in background completion handler (TypeScript narrowing)
  const capturedAgentSpawn = agentSpawn;
  const capturedAgentDef = agentDef!;

  const MAX_IDLE_TIME_MS = 30 * 1000; // 30 seconds idle timeout
  const POLL_INTERVAL_MS = 2000; // 2 seconds between polls

  /**
   * Poll the agent's team inbox for new messages. Returns unread messages
   * formatted as user messages suitable for feeding back into runAgentLoop.
   * Returns an empty array when the idle timeout expires with no messages.
   */
  async function pollTeamInbox(): Promise<Message[]> {
    let idleStart = Date.now();

    while (!subAbortController.signal.aborted) {
      // Check in-memory pending messages first (fast path)
      const record = capturedAgentSpawn.subAgentRegistry.get(agentId);
      const pending = record?.pendingMessages;
      if (pending && pending.length > 0) {
        const msgs = pending.splice(0, pending.length);
        return [{
          role: 'user',
          content: '[Team messages]\n' + msgs.join('\n'),
        }];
      }

      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, POLL_INTERVAL_MS);
        subAbortController.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });

      if (subAbortController.signal.aborted) break;

      try {
        const unread = await drainUnreadMessages(sd, teamName, agentName);
        if (unread.length > 0) {
          const msgsText = unread.map(m =>
            `[${m.from} -> ${m.to}]: ${m.text}`
          ).join('\n');
          return [{
            role: 'user',
            content: '[Team messages]\n' + msgsText,
          }];
        }
        // Reset idle timer after each successful poll — only time out if
        // the agent is truly idle with no activity, not just slow I/O.
        idleStart = Date.now();
      } catch (err) {
        // Inbox may not exist yet — keep polling, but don't count I/O
        // errors as idle time either.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          // Unexpected error — still reset timer to avoid premature timeout
        }
        idleStart = Date.now();
      }

      if (Date.now() - idleStart > MAX_IDLE_TIME_MS) break;
    }

    return [];
  }

  /**
   * Shared completion handler for team agents that finish in the background.
   */
  async function handleTeamAgentBackgroundCompletion(
    result: Awaited<ReturnType<typeof runAgentLoop>>,
  ): Promise<void> {
    let cleanupNote = '';
    if (worktreePath) {
      cleanupNote = await cleanupAgentWorktree({
        worktreePath, worktreeBranch, worktreeGitRoot, worktreeHeadCommit, worktreeHookBased,
      }, capturedAgentSpawn.hookManager);
    }

    const status = result.error ? 'error' : (subAbortController.signal.aborted ? 'stopped' : 'done');
    const compressed = compressTranscript(result.transcript);

    capturedAgentSpawn.subAgentRegistry.update(agentId, {
      status, finishedAt: Date.now(),
      turnCount: result.assistantTurnCount,
      messageCount: result.transcript.length,
      toolCount: result.toolCount,
      result: compressed,
      error: result.error,
      tokenUsage: result.tokenUsage,
      liveToolCalls: [],
      transcript: undefined,
    });

    updateMemberInTeam(sd, teamName, agentId, {
      status, finishedAt: Date.now(),
    }).catch(() => {});

    // Persist to disk
    writeTeamAgentMetadata(agentId, {
      agentType, worktreePath, description: prompt, displayDescription: description,
      model: effectiveModel, createdAt: result.startTime, finishedAt: Date.now(),
      teamName, memberName: agentName, task: prompt, joinedAt: spawnTime,
      allowedTools: Array.isArray(capturedAgentDef.tools) ? capturedAgentDef.tools : undefined,
      disallowedTools: capturedAgentDef.disallowedTools,
      permissionMode: 'auto',
      maxTurns: capturedAgentDef.maxTurns,
      contextBudget: capturedAgentDef.contextBudget,
    }, sd, teamName).catch(() => {});
    saveTeamAgentTranscript(agentId, result.transcript, sd, teamName).catch(() => {});

    capturedAgentSpawn.subAgentRegistry.notifyAgentCompletion(agentId);
  }

  // ── Background path: fire-and-forget with poll loop ──────────────────
  if (isBackground) {
    const teamContext: SubagentContext = createSubagentContext(
      agentId,
      agentType,
      agentDef.source === 'built-in',
    );

    const runParams = {
      agentId, agentType, prompt, agentSpawn,
      systemPromptText: enrichedPrompt,
      effectiveModel, subToolRegistry, subAbortController,
      effectiveMaxTurns: agentDef.maxTurns ?? DEFAULT_MAX_TURNS,
      effectiveContextBudget: agentDef.contextBudget ?? DEFAULT_CONTEXT_BUDGET,
      cwd: worktreePath ?? effectiveCwd,
    };

    const handleError = async (err: unknown) => {
      if (worktreePath) {
        await cleanupAgentWorktree({
          worktreePath, worktreeBranch, worktreeGitRoot, worktreeHeadCommit, worktreeHookBased,
        }, agentSpawn.hookManager).catch(() => {});
      }
      const errorMsg = err instanceof Error ? err.message : String(err);
      agentSpawn.subAgentRegistry.update(agentId, {
        status: 'error', finishedAt: Date.now(),
        error: errorMsg,
        liveToolCalls: [],
        transcript: undefined,
      });
      updateMemberInTeam(sd, teamName, agentId, {
        status: 'error', finishedAt: Date.now(),
      }).catch(() => {});
      agentSpawn.subAgentRegistry.notifyAgentCompletion(agentId);
    };

    runWithAgentContext(teamContext, async () => {
      try {
        let result = await runAgentLoop({ ...runParams, initialMessages });

        // Notify leader immediately with the task result, then keep the
        // agent alive to poll for follow-up messages.
        await handleTeamAgentBackgroundCompletion(result);

        capturedAgentSpawn.subAgentRegistry.update(agentId, { _alive: true });
        while (!subAbortController.signal.aborted) {
          const messages = await pollTeamInbox();
          if (messages.length === 0) break;

          // Reset status so the agent appears running again
          capturedAgentSpawn.subAgentRegistry.update(agentId, {
            status: 'running',
            notified: false,
          });
          updateMemberInTeam(sd, teamName, agentId, {
            status: 'running',
          }).catch(() => {});

          result = await runAgentLoop({ ...runParams, initialMessages: messages });

          // Notify again with updated result
          await handleTeamAgentBackgroundCompletion(result);
        }
        capturedAgentSpawn.subAgentRegistry.update(agentId, { _alive: false });
      } catch (err) {
        capturedAgentSpawn.subAgentRegistry.update(agentId, { _alive: false });
        await handleError(err);
      }
    });

    return {
      content: `Teammate '${agentName}' (${agentId}) spawned in team '${teamName}' (background). Use SendMessage to communicate with it.${worktreePath ? ` (isolated in worktree: ${worktreePath})` : ''}`,
      isError: false,
      duration: Date.now() - spawnTime,
      metadata: { agentId, teamName, agentName, agentType, background: true, worktreePath },
    };
  }

  // ── Foreground path (with Ctrl+B background support) ──────────────────
  const teamContext: SubagentContext = createSubagentContext(
    agentId, agentType, agentDef.source === 'built-in',
  );

  // Create background signal for Ctrl+B support
  let teamBgResolve: (() => void) | null = null;
  const teamBgPromise = new Promise<void>(resolve => { teamBgResolve = resolve; });
  agentSpawn.subAgentRegistry.update(agentId, { _backgroundResolve: teamBgResolve });

  const fgStartTime = Date.now();

  const loopPromise = runWithAgentContext(teamContext, () =>
    runAgentLoop({
      agentId, agentType, prompt, agentSpawn,
      systemPromptText: enrichedPrompt,
      effectiveModel, subToolRegistry, subAbortController,
      effectiveMaxTurns: agentDef.maxTurns ?? DEFAULT_MAX_TURNS,
      effectiveContextBudget: agentDef.contextBudget ?? DEFAULT_CONTEXT_BUDGET,
      initialMessages,
      cwd: worktreePath ?? effectiveCwd,
    }),
  );

  const raceResult = await Promise.race([
    loopPromise.then(r => ({ backgrounded: false as const, result: r })),
    teamBgPromise.then(() => ({ backgrounded: true as const })),
  ]);

  agentSpawn.subAgentRegistry.update(agentId, { _backgroundResolve: null });

  if (raceResult.backgrounded) {
    loopPromise.then(async firstResult => {
      try {
        let result = firstResult;

        // Notify leader immediately with the task result
        await handleTeamAgentBackgroundCompletion(result);

        // Same poll loop as background path: keep agent alive after
        // Ctrl+B moves it to background.
        while (!subAbortController.signal.aborted) {
          const messages = await pollTeamInbox();
          if (messages.length === 0) break;

          capturedAgentSpawn.subAgentRegistry.update(agentId, {
            status: 'running',
            notified: false,
          });
          updateMemberInTeam(sd, teamName, agentId, {
            status: 'running',
          }).catch(() => {});

          result = await runWithAgentContext(teamContext, () =>
            runAgentLoop({
              agentId, agentType, prompt, agentSpawn,
              systemPromptText: enrichedPrompt,
              effectiveModel, subToolRegistry, subAbortController,
              effectiveMaxTurns: agentDef.maxTurns ?? DEFAULT_MAX_TURNS,
              effectiveContextBudget: agentDef.contextBudget ?? DEFAULT_CONTEXT_BUDGET,
              initialMessages: messages,
              cwd: worktreePath ?? effectiveCwd,
            }),
          );

          await handleTeamAgentBackgroundCompletion(result);
        }
        capturedAgentSpawn.subAgentRegistry.update(agentId, { _alive: false });
      } catch (err) {
        capturedAgentSpawn.subAgentRegistry.update(agentId, { _alive: false });
        if (worktreePath) {
          await cleanupAgentWorktree({
            worktreePath, worktreeBranch, worktreeGitRoot, worktreeHeadCommit, worktreeHookBased,
          }, agentSpawn.hookManager).catch(() => {});
        }
        const errorMsg = err instanceof Error ? err.message : String(err);
        agentSpawn.subAgentRegistry.update(agentId, {
          status: 'error', finishedAt: Date.now(),
          error: errorMsg,
          liveToolCalls: [],
          transcript: undefined,
        });
        updateMemberInTeam(sd, teamName, agentId, {
          status: 'error', finishedAt: Date.now(),
        }).catch(() => {});
        agentSpawn.subAgentRegistry.notifyAgentCompletion(agentId);
      }
    });

    return {
      content: `Teammate '${agentName}' (${agentId}) moved to background. Results will be delivered when complete.${worktreePath ? ` (worktree: ${worktreePath})` : ''}`,
      isError: false,
      duration: Date.now() - fgStartTime,
      metadata: { agentId, teamName, agentName, agentType, background: true, worktreePath },
    };
  }

  const result = raceResult.result;

  // Fire-and-forget: persist initial result and start poll loop so the
  // agent stays alive to receive follow-up messages via SendMessage.
  // This mirrors the Ctrl+B background path behaviour.
  void (async () => {
    try {
      let loopResult = result;
      await handleTeamAgentBackgroundCompletion(loopResult);

      while (!subAbortController.signal.aborted) {
        const messages = await pollTeamInbox();
        if (messages.length === 0) break;

        capturedAgentSpawn.subAgentRegistry.update(agentId, {
          status: 'running',
          notified: false,
        });
        updateMemberInTeam(sd, teamName, agentId, {
          status: 'running',
        }).catch(() => {});

        loopResult = await runWithAgentContext(teamContext, () =>
          runAgentLoop({
            agentId, agentType, prompt, agentSpawn,
            systemPromptText: enrichedPrompt,
            effectiveModel, subToolRegistry, subAbortController,
            effectiveMaxTurns: agentDef.maxTurns ?? DEFAULT_MAX_TURNS,
            effectiveContextBudget: agentDef.contextBudget ?? DEFAULT_CONTEXT_BUDGET,
            initialMessages: messages,
            cwd: worktreePath ?? effectiveCwd,
          }),
        );

        await handleTeamAgentBackgroundCompletion(loopResult);
      }
      capturedAgentSpawn.subAgentRegistry.update(agentId, { _alive: false });
    } catch (err) {
      capturedAgentSpawn.subAgentRegistry.update(agentId, { _alive: false });
      if (worktreePath) {
        await cleanupAgentWorktree({
          worktreePath, worktreeBranch, worktreeGitRoot, worktreeHeadCommit, worktreeHookBased,
        }, agentSpawn.hookManager).catch(() => {});
      }
      const errorMsg = err instanceof Error ? err.message : String(err);
      agentSpawn.subAgentRegistry.update(agentId, {
        status: 'error', finishedAt: Date.now(),
        error: errorMsg,
        liveToolCalls: [],
        transcript: undefined,
      });
      updateMemberInTeam(sd, teamName, agentId, {
        status: 'error', finishedAt: Date.now(),
      }).catch(() => {});
      agentSpawn.subAgentRegistry.notifyAgentCompletion(agentId);
    }
  })();

  // Worktree cleanup is deferred to handleTeamAgentBackgroundCompletion
  // since the agent stays alive for the poll loop.

  if (result.error) {
    return {
      content: `Teammate '${agentName}' (${agentId}) error after ${result.assistantTurnCount} turns: ${result.error}`,
      isError: true,
      duration: Date.now() - spawnTime,
      metadata: { agentId, teamName, agentName, agentType, error: result.error, worktreePath, toolCalls: extractToolCalls(result.transcript) },
    };
  }

  return {
    content: `Teammate '${agentName}' (${agentId}) completed initial task. ${result.assistantTurnCount} LLM turns, ${result.toolCount} tools used. Listening for messages...\n\n${compressTranscript(result.transcript)}`,
    isError: false,
    duration: Date.now() - spawnTime,
    metadata: {
      agentId,
      teamName,
      agentName,
      agentType,
      turnCount: result.assistantTurnCount,
      toolCount: result.toolCount,
      duration: Date.now() - spawnTime,
      worktreePath,
      toolCalls: extractToolCalls(result.transcript),
    },
  };
};
