/**
 * Workflow runtime — public API.
 *
 * This module provides the pure runtime layer for executing multi-agent
 * workflow scripts. It has no dependency on the Coderix agent/tool system
 * — the tool plugin layer (src/agents/workflow/) bridges the two.
 */

export { executeWorkflow, extractMeta, validateScript } from './runtime.js';
export { ConcurrencyController, executePipeline } from './concurrency.js';
export { CheckpointManager } from './checkpoint.js';
export type {
  WorkflowMeta,
  PhaseDescriptor,
  JsonSchema,
  AgentOptions,
  PhaseProgress,
  CheckpointEntry,
  CheckpointData,
  AgentFactory,
  ParallelFactory,
  PipelineFactory,
  SandboxGlobals,
  WorkflowExecutionResult,
} from './types.js';
export { WorkflowScriptError } from './types.js';
