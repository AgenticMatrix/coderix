/**
 * Workflow tool executor — bridges the workflow runtime to the Coderix agent system.
 *
 * This is the tool-plugin layer. It:
 *   1. Creates a ConcurrencyController (rate-limit sub-agent spawns)
 *   2. Creates a CheckpointManager (cache/resume agent results)
 *   3. Builds SandboxGlobals backed by agent-runner.ts (spawn real sub-agents)
 *   4. Delegates script execution to the runtime layer (src/workflow/runtime.ts)
 *
 * The runtime layer itself knows nothing about Coderix agents or tools — it only
 * calls the agent/parallel/pipeline factories injected via SandboxGlobals.
 */

import type { ToolExecutor, ToolResult } from '../../tools/types.js';
import type { AgentSpawnContext } from '../../core/types.js';
import type { SandboxGlobals, PhaseProgress } from '../../workflow/types.js';
import { executeWorkflow } from '../../workflow/runtime.js';
import { ConcurrencyController, executePipeline } from '../../workflow/concurrency.js';
import { CheckpointManager } from '../../workflow/checkpoint.js';
import { runWorkflowAgent } from './agent-runner.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_TOTAL_AGENTS = 1000;

// ---------------------------------------------------------------------------
// Tool Executor
// ---------------------------------------------------------------------------

export const execute: ToolExecutor = async (input, options): Promise<ToolResult> => {
  const agentSpawn: AgentSpawnContext | undefined = options.agentSpawn;
  if (!agentSpawn) {
    return {
      content: 'workflow requires agentSpawn context (running inside a sub-agent is not supported).',
      isError: true,
    };
  }

  const script = input.script as string;
  const args = input.args as Record<string, unknown> | undefined;

  if (!script || typeof script !== 'string') {
    return { content: 'workflow requires a non-empty script string.', isError: true };
  }

  // -------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------

  const startTime = Date.now();
  const controller = new ConcurrencyController();
  const checkpoint = new CheckpointManager(script, args);

  // Agent call counter (shared across all primitives)
  const agentCounter = { count: 0 };
  let totalAgentCount = 0;

  // Phase tracking
  const phases: PhaseProgress[] = [];
  let currentPhase = 'main';

  // Log buffer
  const logMessages: string[] = [];

  // -------------------------------------------------------------------
  // Build sandbox globals
  // -------------------------------------------------------------------

  const sandbox: SandboxGlobals = {
    args,
    budget: {
      total: null,
      spent: () => 0,
      remaining: () => Infinity,
    },

    // ── agent() ──────────────────────────────────────────────────
    async agent(prompt: string, opts) {
      if (totalAgentCount >= MAX_TOTAL_AGENTS) {
        throw new Error(
          `Workflow agent limit reached (${MAX_TOTAL_AGENTS} total calls).`,
        );
      }
      totalAgentCount++;

      // Check for cached result (checkpoint / resume)
      const cached = checkpoint.get(prompt);
      if (cached !== null) {
        return cached;
      }

      // Real execution — rate-limited through the concurrency controller
      const result = await controller.enqueue(() =>
        runWorkflowAgent({
          prompt,
          agentSpawn,
          agentType: opts?.agentType ?? 'general-purpose',
          model: opts?.model,
          effort: opts?.effort,
          isolation: opts?.isolation,
          schema: opts?.schema,
          label: opts?.label,
        }),
      );

      // Cache the result for future resume
      checkpoint.set(prompt, result);

      return result;
    },

    // ── parallel() ───────────────────────────────────────────────
    async parallel(thunks) {
      return controller.parallel(thunks.map(t => async () => t()));
    },

    // ── pipeline() ───────────────────────────────────────────────
    async pipeline(items, ...stages) {
      return executePipeline(
        items,
        stages as Array<(item: unknown, index: number) => Promise<unknown>>,
        controller,
      );
    },

    // ── phase() ─────────────────────────────────────────────────
    phase(title: string) {
      if (currentPhase !== title) {
        currentPhase = title;
        // Update or add phase
        const existing = phases.find(p => p.title === title);
        if (!existing) {
          phases.push({ title, agentCount: 0, completedCount: 0 });
        }
      }
    },

    // ── log() ───────────────────────────────────────────────────
    log(message: string) {
      logMessages.push(message);
    },
  };

  // -------------------------------------------------------------------
  // Execute the workflow
  // -------------------------------------------------------------------

  try {
    const result = await executeWorkflow(script, sandbox);

    // Persist checkpoint data
    checkpoint.save();

    const duration = Date.now() - startTime;

    // Merge phases from runtime with our own
    const mergedPhases = result.phases.length > 0 ? result.phases : phases;

    const phaseSummary = mergedPhases
      .map(p => `  - ${p.title}: ${p.agentCount} agents (${p.completedCount} completed)`)
      .join('\n');

    const summary = [
      `Workflow completed in ${(duration / 1000).toFixed(1)}s.`,
      `${result.totalAgentCount} agents used.`,
      phaseSummary ? `\nPhases:\n${phaseSummary}` : '',
      logMessages.length > 0
        ? `\nLogs:\n${logMessages.map(m => `  ${m}`).join('\n')}`
        : '',
      '',
      'Results:',
      ...result.results.slice(0, 20).map((r, i) => `${i + 1}. ${r.slice(0, 500)}`),
    ].join('\n');

    return {
      content: summary,
      isError: false,
      duration,
      metadata: {
        agentCount: result.totalAgentCount,
        phases: mergedPhases,
        resultCount: result.results.length,
        cachedCalls: checkpoint.currentCallIndex - result.totalAgentCount + agentCounter.count,
      },
    };
  } catch (err) {
    checkpoint.save();

    return {
      content: `Workflow failed: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
      duration: Date.now() - startTime,
    };
  }
};
