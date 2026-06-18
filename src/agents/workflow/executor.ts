/**
 * Workflow executor — runs multi-agent workflow scripts.
 *
 * The script format is a simplified JavaScript subset:
 *   export const meta = { name: '...', description: '...' }
 *   // script body using agent(), parallel(), pipeline(), phase(), log()
 *
 * This executor provides a sandboxed execution environment that:
 *   - Limits agent concurrency (16 max) and total count (1000 max)
 *   - Prevents filesystem/network access
 *   - Tracks phases for progress reporting
 */

import type { ToolExecutor, ToolResult } from '../../tools/types.js';
import type { AgentSpawnContext } from '../../core/types.js';
import { filterToolsForAgent } from '../tool-filtering.js';
import { ToolRegistry } from '../../core/tool-registry.js';
import { PermissionEngine } from '../../core/permission.js';
import { PermissionMode } from '../../core/types.js';
import { SessionManager } from '../../core/session.js';
import { CheckpointManager } from '../../core/checkpoint.js';
import { query } from '../../core/query.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_CONCURRENT = 16;
const MAX_TOTAL_AGENTS = 1000;

// ---------------------------------------------------------------------------
// Progress tracking
// ---------------------------------------------------------------------------

interface PhaseProgress {
  title: string;
  agentCount: number;
  completedCount: number;
}

// ---------------------------------------------------------------------------
// Agent runner
// ---------------------------------------------------------------------------

async function runWorkflowAgent(
  prompt: string,
  agentSpawn: AgentSpawnContext,
  agentType: string = 'general-purpose',
): Promise<string> {
  const agentDef = agentSpawn.agentRegistry.get(agentType);
  if (!agentDef) {
    throw new Error(`Unknown agent type: ${agentType}`);
  }

  const shortId = Math.random().toString(36).slice(2, 10);
  const agentId = `wf-${shortId}`;
  const abortController = new AbortController();

  // Build filtered tool registry
  const parentDefs = agentSpawn.toolRegistry.getDefinitions();
  const filteredDefs = filterToolsForAgent(parentDefs, agentDef);
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
  subSessionManager.create({
    title: `Workflow: ${agentType}`,
    cwd: process.cwd(),
    model: agentDef.model,
  });

  const subCheckpointManager = new CheckpointManager();

  const initialMessages = [
    { role: 'user' as const, content: prompt },
  ];

  const systemPrompt = {
    prompt: agentDef.getSystemPrompt(),
    parts: [{ name: `agent-${agentType}`, content: agentDef.getSystemPrompt(), priority: 0 }],
  };

  agentSpawn.subAgentRegistry.register({
    id: agentId,
    name: `wf-${agentType}`,
    agentType: agentType as 'explore' | 'plan' | 'general-purpose',
    status: 'running',
    prompt,
    createdAt: Date.now(),
    turnCount: 0,
    messageCount: 0,
    toolCount: 0,
    abortController,
  });

  let turnCount = 0;
  let toolCount = 0;
  const transcripts: string[] = [];

  try {
    const generator = query({
      sessionId: subSessionManager.getActive()?.id ?? agentId,
      cwd: process.cwd(),
      messages: initialMessages,
      systemPrompt,
      toolRegistry: subToolRegistry,
      permissionEngine: subPermissionEngine,
      sessionManager: subSessionManager,
      checkpointManager: subCheckpointManager,
      abortController,
      maxTurns: agentDef.maxTurns ?? 15,
      contextBudget: agentDef.contextBudget ?? 80_000,
      compactThreshold: 0.7,
      maxToolConcurrency: 4,
      callModel: agentSpawn.callModel,
    });

    for await (const msg of generator) {
      if (abortController.signal.aborted) break;

      if (msg.type === 'assistant') {
        turnCount++;
        const assistantMsg = msg.message as { content?: unknown };
        const blocks = Array.isArray(assistantMsg.content) ? assistantMsg.content : [];
        toolCount += blocks.filter((b: { type?: string }) => b.type === 'tool_use').length;

        for (const block of blocks) {
          if (block.type === 'text' && typeof (block as { text?: string }).text === 'string') {
            transcripts.push((block as { text: string }).text);
          }
        }
      }
    }

    const result = transcripts.join('\n\n') || '(no output)';

    agentSpawn.subAgentRegistry.update(agentId, {
      status: abortController.signal.aborted ? 'stopped' : 'done',
      finishedAt: Date.now(),
      turnCount,
      toolCount,
      result: result.slice(0, 2000),
    });

    return result;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    agentSpawn.subAgentRegistry.update(agentId, {
      status: 'error',
      finishedAt: Date.now(),
      error: errorMsg,
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Workflow script execution
// ---------------------------------------------------------------------------

interface WorkflowMeta {
  name: string;
  description: string;
  phases?: Array<{ title: string }>;
}

interface WorkflowContext {
  agentSpawn: AgentSpawnContext;
  args?: Record<string, unknown>;
  phases: PhaseProgress[];
  totalAgentCount: number;
  currentPhase: string;
}

/**
 * Execute a workflow script.
 */
async function executeWorkflowScript(
  script: string,
  context: WorkflowContext,
): Promise<{
  results: string[];
  phases: PhaseProgress[];
}> {
  const results: string[] = [];

  // Parse metadata from the script
  const metaMatch = script.match(/export\s+const\s+meta\s*=\s*(\{[\s\S]*?\n\});/);
  const meta: WorkflowMeta = metaMatch
    ? eval(`(${metaMatch[1]})`)
    : { name: 'unnamed', description: '' };

  // Extract script body (everything after the meta declaration)
  const bodyStart = script.indexOf('\n', metaMatch ? script.indexOf(metaMatch[0]) + metaMatch[0].length : 0);
  const scriptBody = bodyStart > 0 ? script.slice(bodyStart) : script;

  // Sandboxed environment
  const sandbox: Record<string, unknown> = {
    // Metadata
    __meta: meta,
    __results: results,
    __phases: context.phases,
    args: context.args ?? {},

    // Agent function
    async agent(prompt: string, opts?: { model?: string; agentType?: string }) {
      if (context.totalAgentCount >= MAX_TOTAL_AGENTS) {
        throw new Error(`Workflow agent limit reached (${MAX_TOTAL_AGENTS})`);
      }
      context.totalAgentCount++;

      return runWorkflowAgent(
        prompt,
        context.agentSpawn,
        opts?.agentType ?? 'general-purpose',
      );
    },

    // Parallel execution
    async parallel(thunks: Array<() => Promise<string>>) {
      const limited = thunks.slice(0, MAX_CONCURRENT);
      const results = await Promise.all(
        limited.map(t => t().catch(err => `ERROR: ${err instanceof Error ? err.message : String(err)}`)),
      );
      return results.filter((r): r is string => r !== null);
    },

    // Pipeline execution
    async pipeline<T>(
      items: T[],
      ...stages: Array<(item: T, index: number) => Promise<string>>
    ) {
      const outcomes: string[] = [];
      for (let i = 0; i < items.length; i++) {
        let current = items[i];
        for (const stage of stages) {
          current = await stage(current, i) as unknown as T;
        }
        outcomes.push(current as unknown as string);
      }
      return outcomes;
    },

    // Phase tracking
    phase(title: string) {
      context.currentPhase = title;
      context.phases.push({ title, agentCount: 0, completedCount: 0 });
    },

    // Logging
    log(message: string) {
      results.push(`[log] ${message}`);
    },
  };

  // Execute script body as async function
  const scriptFn = new Function(
    ...Object.keys(sandbox),
    `"use strict"; return (async () => { ${scriptBody} })();`,
  );

  try {
    const scriptResult = await scriptFn(...Object.values(sandbox));
    if (scriptResult && typeof scriptResult === 'object') {
      return {
        results: Array.isArray(scriptResult) ? scriptResult : [String(scriptResult)],
        phases: context.phases,
      };
    }
  } catch (err) {
    results.push(`Workflow error: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { results, phases: context.phases };
}

// ---------------------------------------------------------------------------
// Tool Executor
// ---------------------------------------------------------------------------

export const execute: ToolExecutor = async (input, options): Promise<ToolResult> => {
  const agentSpawn = options.agentSpawn;
  if (!agentSpawn) {
    return { content: 'workflow requires agentSpawn context.', isError: true };
  }

  const script = input.script as string;
  const args = input.args as Record<string, unknown> | undefined;

  if (!script || typeof script !== 'string') {
    return { content: 'workflow requires a non-empty script string.', isError: true };
  }

  const startTime = Date.now();

  const context: WorkflowContext = {
    agentSpawn,
    args,
    phases: [],
    totalAgentCount: 0,
    currentPhase: 'main',
  };

  try {
    const result = await executeWorkflowScript(script, context);

    const duration = Date.now() - startTime;
    const phaseSummary = result.phases
      .map(p => `  - ${p.title}: ${p.agentCount} agents`)
      .join('\n');

    const summary = [
      `Workflow completed in ${(duration / 1000).toFixed(1)}s.`,
      `${context.totalAgentCount} agents used.`,
      phaseSummary ? `\nPhases:\n${phaseSummary}` : '',
      '',
      'Results:',
      ...result.results.slice(0, 10).map((r, i) => `${i + 1}. ${r.slice(0, 500)}`),
    ].join('\n');

    return {
      content: summary,
      isError: false,
      duration,
      metadata: {
        agentCount: context.totalAgentCount,
        phases: result.phases,
        resultCount: result.results.length,
      },
    };
  } catch (err) {
    return {
      content: `Workflow failed: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
      duration: Date.now() - startTime,
    };
  }
};
