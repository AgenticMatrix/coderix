import { readdir } from 'node:fs/promises';
import type { ToolExecutor, ToolResult } from '../../../tools/types.js';
import type { Message, AgentSpawnContext, ToolContext } from '../../../core/types.js';
import type { AgentDefinition } from '../../../core/types.js';
import { ToolRegistry } from '../../../core/tool-registry.js';
import { RiskLevel } from '../../../core/types.js';
import { filterToolsForAgent } from '../../../agents/tool-filtering.js';
import { loadTeamConfig, teamDir, listTeams } from '../../team-store.js';
import { addMemberToTeam, updateMemberInTeam } from '../../../utils/swarm/teamHelpers.js';
import type { SwarmTeamMember } from '../../../utils/swarm/teamHelpers.js';
import teamMessagePlugin from '../team-message/index.js';
import {
  runAgentLoop,
  compressTranscript,
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
        { ...toolInput, from: agentId },
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
  // Inherit the parent agent's FULL system prompt as the base, then layer on
  // the agent type's custom instructions and the team member addendum.
  // This gives team members the same tool knowledge and environment context
  // as the leader, matching claude-code-best's approach.
  const userPrompt = agentDef.initialPrompt
    ? `${agentDef.initialPrompt}\n\n${prompt}`
    : prompt;

  let enrichedPrompt: string;
  if (agentSpawn.renderedSystemPrompt) {
    enrichedPrompt = agentSpawn.renderedSystemPrompt.prompt;
  } else {
    // Fallback: reassemble from agent definition + system prompt assembler
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
    ? peerMembers.map(m => `  - ${m.name} (\`${m.agentId}\`) [${m.agentType}]`).join('\n')
    : '  (none)';
  const teamCtx = [
    '',
    '# Team Communication',
    `You are "${agentName}" (\`${agentId}\`) in team "${teamName}".`,
    `The team leader is at "leader" — use SendMessage(to: "leader", text: "...") to report.`,
    '',
    `Peer workers:\n${peerList}`,
    '- SendMessage(to: "<agentId>") to message a specific teammate',
    '- SendMessage(to: "*") to broadcast to all workers (use sparingly)',
    '- Just writing text is NOT visible to others — you MUST use SendMessage',
    '',
    'Your work is coordinated through the task system and teammate messaging.',
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
  });

  agentSpawn.sessionManager.trackSubAgent(agentId);

  // ── Run in background ───────────────────────────────────────────────
  const spawnTime = Date.now();
  const teamContext: SubagentContext = createSubagentContext(
    agentId,
    agentType,
    agentDef.source === 'built-in',
  );

  runWithAgentContext(teamContext, () => {
    runAgentLoop({
      agentId, agentType, prompt, agentSpawn,
      systemPromptText: enrichedPrompt,
      effectiveModel, subToolRegistry, subAbortController,
      effectiveMaxTurns: agentDef.maxTurns ?? DEFAULT_MAX_TURNS,
      effectiveContextBudget: agentDef.contextBudget ?? DEFAULT_CONTEXT_BUDGET,
      initialMessages,
      cwd: worktreePath ?? effectiveCwd,
    }).then(async result => {
      let cleanupNote = '';
      if (worktreePath) {
        cleanupNote = await cleanupAgentWorktree({
          worktreePath, worktreeBranch, worktreeGitRoot, worktreeHeadCommit, worktreeHookBased,
        }, agentSpawn.hookManager);
      }

      const status = result.error ? 'error' : (subAbortController.signal.aborted ? 'stopped' : 'done');
      const compressed = compressTranscript(result.transcript);

      agentSpawn.subAgentRegistry.update(agentId, {
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
        allowedTools: Array.isArray(agentDef.tools) ? agentDef.tools : undefined,
        disallowedTools: agentDef.disallowedTools,
        permissionMode: 'auto',
        maxTurns: agentDef.maxTurns,
        contextBudget: agentDef.contextBudget,
      }, sd, teamName).catch(() => {});
      saveTeamAgentTranscript(agentId, result.transcript, sd, teamName).catch(() => {});

      agentSpawn.subAgentRegistry.notifyAgentCompletion(agentId);
    }).catch(async err => {
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
    });
  });

  return {
    content: `Teammate '${agentName}' (${agentId}) spawned in team '${teamName}'. Use SendMessage to communicate with it.${worktreePath ? ` (isolated in worktree: ${worktreePath})` : ''}`,
    isError: false,
    duration: Date.now() - spawnTime,
    metadata: {
      agentId,
      teamName,
      agentName,
      agentType,
      background: true,
      worktreePath,
    },
  };
};
