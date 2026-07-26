/**
 * Workflow agent runner — spawns and runs sub-agents for the workflow tool.
 *
 * Extracted from the original workflow executor and enhanced with:
 *   - StructuredOutput (schema → JSON Schema validation + retry)
 *   - Model override (model)
 *   - Reasoning effort control (effort)
 *   - Worktree isolation (isolation)
 *   - Custom agent type (agentType)
 *
 * Reuses the same sub-agent infrastructure as the Agent tool:
 *   - Tool filtering (filterToolsForAgent / GLOBAL_DISALLOWED_FOR_SUBAGENTS)
 *   - Permission engine (AUTO mode)
 *   - Session / checkpoint managers
 *   - query() generator for the agent loop
 */

import type { ToolExecutor, ToolResult } from '../../tools/types.js';
import type { Message, ContentBlock, AgentSpawnContext, ToolContext, RiskLevel } from '../../core/types.js';
import type { SystemPrompt } from '../../core/system-prompt.js';
import type { JsonSchema } from '../../workflow/types.js';
import { ToolRegistry } from '../../core/tool-registry.js';
import { PermissionEngine } from '../../core/permission.js';
import { PermissionMode } from '../../core/types.js';
import { SessionManager } from '../../core/session.js';
import { CheckpointManager } from '../../core/checkpoint.js';
import { filterToolsForAgent } from '../tool-filtering.js';
import { query } from '../../core/query.js';
import { truncateToTokenLimit, countTokens } from '../../core/token-counter.js';
import {
  createAgentWorktree,
  removeAgentWorktree,
  hasWorktreeChanges,
} from '../../utils/worktree.js';

// ---------------------------------------------------------------------------
// StructuredOutput validation
// ---------------------------------------------------------------------------

/**
 * Lightweight JSON Schema validator.
 * Supports: type, properties, required, items, enum, additionalProperties.
 */
function validateJsonSchema(data: unknown, schema: JsonSchema, path: string = '$'): string | null {
  if (schema.enum !== undefined) {
    if (!schema.enum.some(v => JSON.stringify(v) === JSON.stringify(data))) {
      return `${path}: value must be one of [${schema.enum.map(v => JSON.stringify(v)).join(', ')}]`;
    }
    return null;
  }

  const type = schema.type;
  if (type) {
    if (type === 'null') {
      if (data !== null) return `${path}: expected null, got ${typeof data}`;
      return null;
    }

    if (type === 'object') {
      if (data === null || typeof data !== 'object' || Array.isArray(data)) {
        return `${path}: expected object, got ${data === null ? 'null' : Array.isArray(data) ? 'array' : typeof data}`;
      }
      const obj = data as Record<string, unknown>;

      // Check required properties
      if (schema.required) {
        for (const req of schema.required) {
          if (!(req in obj)) {
            return `${path}: missing required property "${req}"`;
          }
        }
      }

      // Check properties
      if (schema.properties) {
        for (const [key, propSchema] of Object.entries(schema.properties)) {
          if (key in obj) {
            const err = validateJsonSchema(obj[key], propSchema, `${path}.${key}`);
            if (err) return err;
          }
        }
      }

      // Check additionalProperties
      if (schema.additionalProperties === false && schema.properties) {
        const allowed = new Set(Object.keys(schema.properties));
        for (const key of Object.keys(obj)) {
          if (!allowed.has(key)) {
            return `${path}: disallowed additional property "${key}"`;
          }
        }
      }

      return null;
    }

    if (type === 'array') {
      if (!Array.isArray(data)) {
        return `${path}: expected array, got ${typeof data}`;
      }
      if (schema.items) {
        for (let i = 0; i < data.length; i++) {
          const err = validateJsonSchema(data[i], schema.items, `${path}[${i}]`);
          if (err) return err;
        }
      }
      return null;
    }

    // Primitive types
    if (type === 'string' && typeof data !== 'string') {
      return `${path}: expected string, got ${typeof data}`;
    }
    if (type === 'number' && typeof data !== 'number') {
      return `${path}: expected number, got ${typeof data}`;
    }
    if (type === 'boolean' && typeof data !== 'boolean') {
      return `${path}: expected boolean, got ${typeof data}`;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// StructuredOutput tool
// ---------------------------------------------------------------------------

function createStructuredOutputTool(schema: JsonSchema): {
  name: string;
  definition: { name: string; description: string; input_schema: Record<string, unknown> };
  validate: (input: Record<string, unknown>) => string | null;
} {
  const name = 'structured_output';

  const definition = {
    name,
    description:
      'Return structured JSON output matching the required schema. ' +
      'You MUST call this tool as your final action. The output will be validated.',
    input_schema: {
      type: 'object',
      properties: {
        output: {
          description:
            'The structured output matching the requested schema: ' +
            JSON.stringify(schema),
        },
      },
      required: ['output'],
    },
  };

  return {
    name,
    definition,
    validate: (input: Record<string, unknown>) => {
      const output = input.output;
      if (output === undefined) {
        return 'Missing required field: output';
      }
      return validateJsonSchema(output, schema, 'output');
    },
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TURNS = 200;
const DEFAULT_CONTEXT_BUDGET = 120_000;
const DEFAULT_MAX_CONCURRENCY = 8;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shortId(): string {
  return Math.random().toString(36).slice(2, 10);
}

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
  if (countTokens(body) <= 32000) return body;
  return truncateToTokenLimit(body, 32000);
}

// ---------------------------------------------------------------------------
// Agent options
// ---------------------------------------------------------------------------

export interface RunAgentOptions {
  prompt: string;
  agentSpawn: AgentSpawnContext;
  agentType?: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  isolation?: 'worktree';
  schema?: JsonSchema;
  label?: string;
}

// ---------------------------------------------------------------------------
// Core runner
// ---------------------------------------------------------------------------

interface RunAgentLoopParams {
  agentId: string;
  agentType: string;
  prompt: string;
  agentSpawn: AgentSpawnContext;
  systemPromptText: string;
  effectiveModel: string | undefined;
  effectiveMaxTurns: number;
  effectiveContextBudget: number;
  initialMessages: Message[];
  subToolRegistry: ToolRegistry;
  subAbortController: AbortController;
  /** If set, the sub-agent must call structured_output with valid JSON. */
  outputSchema?: JsonSchema;
  /** Working directory override (for worktree isolation). */
  cwd?: string;
}

async function runAgentLoop(params: RunAgentLoopParams): Promise<{
  agentId: string;
  agentType: string;
  assistantTurnCount: number;
  toolCount: number;
  transcript: Message[];
  startTime: number;
  error?: string;
  structuredOutput?: unknown;
}> {
  const {
    agentId, agentType, prompt, agentSpawn,
    systemPromptText, effectiveModel, effectiveMaxTurns, effectiveContextBudget,
    initialMessages, subToolRegistry, subAbortController, outputSchema, cwd,
  } = params;

  const effectiveCwd = cwd ?? process.cwd();

  const subPermissionEngine = new PermissionEngine(effectiveCwd);
  subPermissionEngine.setMode(PermissionMode.AUTO);

  const subSessionManager = new SessionManager();
  subSessionManager.create({
    title: `Workflow: ${agentType}`,
    cwd: effectiveCwd,
    model: effectiveModel,
    parentSessionId: agentSpawn.sessionManager.getActive()?.id,
  });

  const subCheckpointManager = new CheckpointManager();

  const workerPrompt: SystemPrompt = {
    prompt: systemPromptText,
    parts: [{ name: `agent-${agentType}`, content: systemPromptText, priority: 0 }],
  };

  // Inject structured_output tool if schema is set
  let structuredOutputValidator: ((input: Record<string, unknown>) => string | null) | undefined;
  if (outputSchema) {
    const soTool = createStructuredOutputTool(outputSchema);
    structuredOutputValidator = soTool.validate;

    // Register the structured_output tool
    subToolRegistry.register(
      {
        name: soTool.name,
        description: soTool.definition.description,
        input_schema: soTool.definition.input_schema,
        riskLevel: 'safe' as RiskLevel,
      },
      async (toolInput: Record<string, unknown>, _ctx: ToolContext) => {
        const error = structuredOutputValidator!(toolInput);
        if (error) {
          return {
            content: `Validation error: ${error}. Please fix and call structured_output again.`,
            isError: true,
          };
        }
        return {
          content: `Valid output: ${JSON.stringify(toolInput.output)}`,
          isError: false,
          metadata: { validated: true },
        };
      },
    );
  }

  const startTime = Date.now();
  let assistantTurnCount = 0;
  let toolCount = 0;
  const transcript: Message[] = [];
  let structuredOutput: unknown;

  // StructuredOutput retry loop (max 3 attempts)
  for (let attempt = 0; attempt < 3; attempt++) {
    if (subAbortController.signal.aborted) break;

    const attemptMessages: Message[] = attempt === 0
      ? [...initialMessages]
      : [
          ...initialMessages,
          {
            role: 'user' as const,
            content: `Your previous response did not produce valid structured output. Please try again and make sure to call the structured_output tool with valid JSON matching the schema.`,
          },
        ];

    try {
      const generator = query({
        sessionId: subSessionManager.getActive()?.id ?? agentId,
        cwd: effectiveCwd,
        messages: attemptMessages,
        systemPrompt: workerPrompt,
        toolRegistry: subToolRegistry,
        permissionEngine: subPermissionEngine,
        sessionManager: subSessionManager,
        checkpointManager: subCheckpointManager,
        abortController: subAbortController,
        maxTurns: effectiveMaxTurns,
        contextBudget: effectiveContextBudget,
        compactThreshold: 0.85,
        maxToolConcurrency: DEFAULT_MAX_CONCURRENCY,
        callModel: agentSpawn.callModel,
        hookManager: agentSpawn.hookManager,
        subAgentRegistry: agentSpawn.subAgentRegistry,
        systemPromptAssembler: agentSpawn.systemPromptAssembler,
        agentRegistry: agentSpawn.agentRegistry,
        agentRole: 'worker',
      });

      for await (const msg of generator) {
        if (subAbortController.signal.aborted) break;

        switch (msg.type) {
          case 'assistant': {
            assistantTurnCount++;
            const assistantMsg = msg.message as unknown as Message;
            transcript.push(assistantMsg);
            const blocks = Array.isArray(assistantMsg.content) ? assistantMsg.content : [];
            toolCount += blocks.filter((b: ContentBlock) => b.type === 'tool_use').length;

            // Check for structured_output result
            if (outputSchema) {
              for (const block of blocks) {
                if (block.type === 'tool_result') {
                  const trBlock = block as { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean; metadata?: Record<string, unknown> };
                  // Look back for the matching tool_use to get the name
                  for (const ub of blocks) {
                    if (ub.type === 'tool_use') {
                      const tuBlock = ub as { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
                      if (tuBlock.id === trBlock.tool_use_id && tuBlock.name === 'structured_output' && !trBlock.is_error) {
                        structuredOutput = tuBlock.input.output;
                      }
                    }
                  }
                }
              }
            }
            break;
          }
          case 'user':
            transcript.push(msg.message as unknown as Message);
            break;
        }
      }

      // If we got structured output, stop retrying
      if (structuredOutput !== undefined) break;
      if (!outputSchema) break; // No schema → done

      // No structured output produced → retry
    } catch (err) {
      if (attempt < 2) continue; // Retry
      return {
        agentId, agentType, assistantTurnCount, toolCount,
        transcript, startTime,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return {
    agentId, agentType, assistantTurnCount, toolCount,
    transcript, startTime,
    structuredOutput,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run a single workflow sub-agent.
 *
 * This is the bridge between the workflow runtime and the Coderix agent
 * system. It spawns a sub-agent of the given type, runs it to completion,
 * and returns the compressed text transcript (or structured output).
 */
export async function runWorkflowAgent(options: RunAgentOptions): Promise<string> {
  const {
    prompt,
    agentSpawn,
    agentType = 'general-purpose',
    model,
    schema,
    label,
    isolation,
  } = options;

  const agentDef = agentSpawn.agentRegistry.get(agentType);
  if (!agentDef) {
    throw new Error(`Unknown agent type: ${agentType}`);
  }

  const agentId = `wf-${shortId()}`;
  const subAbortController = new AbortController();

  // ── Worktree isolation ──────────────────────────────────────────────
  let worktreePath: string | undefined;
  let worktreeBranch: string | undefined;
  let worktreeGitRoot: string | undefined;
  let worktreeHeadCommit: string | undefined;
  let worktreeHookBased: boolean | undefined;

  if (isolation === 'worktree') {
    const wt = await createAgentWorktree(`wf-${agentId.slice(0, 8)}`, agentSpawn.hookManager);
    worktreePath = wt.worktreePath;
    worktreeBranch = wt.worktreeBranch;
    worktreeGitRoot = wt.gitRoot;
    worktreeHeadCommit = wt.headCommit;
    worktreeHookBased = wt.hookBased;
  }

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

  const effectiveModel = model ?? agentDef.model;

  // Build system prompt — inject schema instruction if needed
  let systemPromptText = agentDef.getSystemPrompt();
  if (schema) {
    systemPromptText +=
      '\n\n' +
      '## Structured Output Required\n\n' +
      'You MUST call the `structured_output` tool as your final action. ' +
      'The output parameter must be a valid JSON object matching this schema:\n\n' +
      '```json\n' +
      JSON.stringify(schema, null, 2) +
      '\n```\n\n' +
      'Do NOT end the conversation without calling `structured_output`.';
  }

  const initialMessages: Message[] = [
    { role: 'user', content: prompt },
  ];

  // Register in sub-agent registry
  agentSpawn.subAgentRegistry.register({
    id: agentId,
    name: label ?? `wf-${agentType}`,
    agentType: agentType as 'explore' | 'plan' | 'general-purpose',
    status: 'running',
    prompt,
    createdAt: Date.now(),
    turnCount: 0,
    messageCount: 0,
    toolCount: 0,
    abortController: subAbortController,
    notified: false,
  });

  const result = await runAgentLoop({
    agentId,
    agentType,
    prompt,
    agentSpawn,
    systemPromptText,
    effectiveModel,
    effectiveMaxTurns: agentDef.maxTurns ?? DEFAULT_MAX_TURNS,
    effectiveContextBudget: agentDef.contextBudget ?? DEFAULT_CONTEXT_BUDGET,
    initialMessages,
    subToolRegistry,
    subAbortController,
    outputSchema: schema,
    cwd: worktreePath,
  });

  // Worktree cleanup
  let cleanupNote = '';
  if (worktreePath) {
    try {
      let changed = false;
      if (worktreeHeadCommit && !worktreeHookBased) {
        changed = await hasWorktreeChanges(worktreePath, worktreeHeadCommit);
      }
      if (changed) {
        cleanupNote = `\nWorktree preserved at: ${worktreePath}`;
      } else {
        await removeAgentWorktree(worktreePath, worktreeBranch, worktreeGitRoot, worktreeHookBased, agentSpawn.hookManager);
      }
    } catch {
      cleanupNote = `\nWorktree left at: ${worktreePath} (cleanup failed)`;
    }
  }

  const status = result.error
    ? 'error'
    : subAbortController.signal.aborted
      ? 'stopped'
      : 'done';

  agentSpawn.subAgentRegistry.update(agentId, {
    status,
    finishedAt: Date.now(),
    turnCount: result.assistantTurnCount,
    messageCount: result.transcript.length,
    toolCount: result.toolCount,
    result: schema && result.structuredOutput
      ? JSON.stringify(result.structuredOutput)
      : compressTranscript(result.transcript),
    transcript: result.transcript,
    error: result.error,
  });

  if (result.error) {
    throw new Error(`Workflow agent ${agentType} failed: ${result.error}${cleanupNote}`);
  }

  // Return structured output as JSON string, or compressed transcript
  if (schema && result.structuredOutput !== undefined) {
    return JSON.stringify(result.structuredOutput);
  }

  return compressTranscript(result.transcript) + cleanupNote;
}
