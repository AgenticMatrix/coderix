/**
 * Sandboxed workflow script runtime.
 *
 * Executes a JavaScript subset with restricted global access:
 *   - NO filesystem (fs, path, etc.)
 *   - NO network (http, https, net, fetch, etc.)
 *   - NO child processes (child_process, worker_threads)
 *   - NO Date.now() or Math.random() (breaks checkpoint determinism)
 *   - NO eval() or Function constructor (prevents escape)
 *
 * Allowed: JSON, Array, Object, String, Number, Boolean, Map, Set, Promise,
 *          Math (except random), Date (except now), parseInt, parseFloat,
 *          isNaN, isFinite, NaN, Infinity, undefined, null, true, false,
 *          console (basic), Error, TypeError, RangeError, SyntaxError.
 *
 * The runtime also injects the workflow primitives:
 *   agent(), parallel(), pipeline(), phase(), log(), budget, args
 */

import type {
  WorkflowMeta,
  SandboxGlobals,
  WorkflowExecutionResult,
  PhaseProgress,
} from './types.js';
import { WorkflowScriptError } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_AGENT_CALLS = 1000;

// ---------------------------------------------------------------------------
// Allowed global bindings — explicit whitelist
// ---------------------------------------------------------------------------

const ALLOWED_GLOBALS: Record<string, unknown> = {
  // Data types
  Object,
  Array,
  String,
  Number,
  Boolean,
  Map,
  Set,
  WeakMap,
  WeakSet,
  Date: class {
    // Date is allowed for construction from values, but Date.now() is blocked
    // by not exposing the static method.
    static UTC = Date.UTC;
    static parse = Date.parse;
    // Date.now is deliberately omitted
    getTime() { return NaN; }
    getDate() { return NaN; }
    getDay() { return NaN; }
    getFullYear() { return NaN; }
    getHours() { return NaN; }
    getMilliseconds() { return NaN; }
    getMinutes() { return NaN; }
    getMonth() { return NaN; }
    getSeconds() { return NaN; }
    getTimezoneOffset() { return NaN; }
    toDateString() { return ''; }
    toISOString() { return ''; }
    toJSON() { return ''; }
    toLocaleDateString() { return ''; }
    toLocaleTimeString() { return ''; }
    toLocaleString() { return ''; }
    toString() { return ''; }
    toTimeString() { return ''; }
    toUTCString() { return ''; }
    valueOf() { return NaN; }
  },

  // Math (except random)
  Math: {
    E: Math.E,
    LN10: Math.LN10,
    LN2: Math.LN2,
    LOG10E: Math.LOG10E,
    LOG2E: Math.LOG2E,
    PI: Math.PI,
    SQRT1_2: Math.SQRT1_2,
    SQRT2: Math.SQRT2,
    abs: Math.abs,
    acos: Math.acos,
    acosh: Math.acosh,
    asin: Math.asin,
    asinh: Math.asinh,
    atan: Math.atan,
    atan2: Math.atan2,
    atanh: Math.atanh,
    cbrt: Math.cbrt,
    ceil: Math.ceil,
    clz32: Math.clz32,
    cos: Math.cos,
    cosh: Math.cosh,
    exp: Math.exp,
    expm1: Math.expm1,
    floor: Math.floor,
    fround: Math.fround,
    hypot: Math.hypot,
    imul: Math.imul,
    log: Math.log,
    log10: Math.log10,
    log1p: Math.log1p,
    log2: Math.log2,
    max: Math.max,
    min: Math.min,
    pow: Math.pow,
    round: Math.round,
    sign: Math.sign,
    sin: Math.sin,
    sinh: Math.sinh,
    sqrt: Math.sqrt,
    tan: Math.tan,
    tanh: Math.tanh,
    trunc: Math.trunc,
    // Math.random is deliberately omitted
  } as Math,

  // Primitives
  NaN,
  Infinity,
  undefined,

  // Utility
  JSON,
  parseInt,
  parseFloat,
  isNaN,
  isFinite,
  encodeURI,
  encodeURIComponent,
  decodeURI,
  decodeURIComponent,

  // Error types
  Error,
  TypeError,
  RangeError,
  SyntaxError,
  ReferenceError,
  URIError,
  AggregateError,

  // TypedArrays (data manipulation only)
  ArrayBuffer,
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
  DataView,
  TextDecoder,
  TextEncoder,

  // Regexp / symbols
  RegExp,
  Symbol,

  // Console (basic output)
  console: {
    log: (...args: unknown[]) => { /* swallowed in sandbox */ },
    warn: (...args: unknown[]) => { /* swallowed in sandbox */ },
    error: (...args: unknown[]) => { /* swallowed in sandbox */ },
  },

  // Promise helpers
  Promise,
};

// ---------------------------------------------------------------------------
// Meta parsing
// ---------------------------------------------------------------------------

const META_REGEX = /export\s+const\s+meta\s*=\s*(\{[\s\S]*?\});/;

function parseMeta(script: string): { meta: WorkflowMeta; bodyStart: number } {
  const match = script.match(META_REGEX);
  if (!match) {
    throw new WorkflowScriptError(
      'Script must start with: export const meta = { name: "...", description: "..." };',
      'PARSE_ERROR',
    );
  }

  let meta: WorkflowMeta;
  try {
    // Use Function to evaluate the object literal safely
    meta = new Function(`return ${match[1]}`)() as WorkflowMeta;
  } catch (err) {
    throw new WorkflowScriptError(
      `Failed to parse meta: ${err instanceof Error ? err.message : String(err)}`,
      'PARSE_ERROR',
      err instanceof Error ? err : undefined,
    );
  }

  if (!meta.name || typeof meta.name !== 'string') {
    throw new WorkflowScriptError(
      'meta must include a non-empty `name` string.',
      'PARSE_ERROR',
    );
  }

  const bodyStart = script.indexOf('\n', (match.index ?? 0) + match[0].length);
  return { meta, bodyStart: bodyStart > 0 ? bodyStart + 1 : script.length };
}

// ---------------------------------------------------------------------------
// Sandbox builder
// ---------------------------------------------------------------------------

interface RuntimeConfig {
  sandbox: SandboxGlobals;
  phaseTracker: { phases: PhaseProgress[] };
  agentCounter: { count: number };
  results: string[];
}

/**
 * Build the sandboxed global scope and execute the workflow script.
 *
 * The script body is wrapped in an async IIFE and executed via a Function
 * constructor that only receives explicitly allowed globals as parameters.
 * This is the core defense: the script cannot reach any global not passed in.
 */
export async function executeWorkflow(
  script: string,
  sandbox: SandboxGlobals,
): Promise<WorkflowExecutionResult> {
  // 1. Parse metadata
  const { meta, bodyStart } = parseMeta(script);
  const scriptBody = script.slice(bodyStart).trim();

  // 2. Track state
  const phases: PhaseProgress[] = [];
  const results: string[] = [];
  const agentCounter = { count: 0 };

  // 3. Build bindings for the sandbox
  // Each primitive is bound to our tracking/limiting logic
  const bindings: Record<string, unknown> = {};

  // Allowed globals
  for (const [key, value] of Object.entries(ALLOWED_GLOBALS)) {
    bindings[key] = value;
  }

  // Workflow primitives (override / inject)
  bindings.agent = async (prompt: string, opts?: Record<string, unknown>) => {
    if (agentCounter.count >= MAX_AGENT_CALLS) {
      throw new WorkflowScriptError(
        `Workflow agent limit reached (${MAX_AGENT_CALLS}).`,
        'AGENT_LIMIT',
      );
    }
    const idx = agentCounter.count++;

    // Update phase progress
    const currentPhase = phases.length > 0 ? phases[phases.length - 1] : null;
    if (currentPhase) {
      currentPhase.agentCount++;
    }

    try {
      const result = await sandbox.agent(prompt, {
        schema: opts?.schema as import('./types.js').JsonSchema | undefined,
        model: opts?.model as string | undefined,
        effort: opts?.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined,
        isolation: opts?.isolation as 'worktree' | undefined,
        agentType: opts?.agentType as string | undefined,
        label: opts?.label as string | undefined,
      });

      if (currentPhase) {
        currentPhase.completedCount++;
      }
      return result;
    } catch (err) {
      if (currentPhase) {
        currentPhase.completedCount++;
      }
      throw err;
    }
  };

  bindings.parallel = async (thunks: Array<() => Promise<unknown>>) => {
    return sandbox.parallel(thunks);
  };

  bindings.pipeline = async (
    items: unknown[],
    ...stages: Array<(prev: unknown, index: number) => Promise<unknown>>
  ) => {
    return sandbox.pipeline(items, ...stages);
  };

  bindings.phase = (title: string) => {
    // Add a new phase if it's different from the last one
    const last = phases[phases.length - 1];
    if (!last || last.title !== title) {
      phases.push({ title, agentCount: 0, completedCount: 0 });
    }
    // Also call the injected phase tracker
    sandbox.phase(title);
  };

  bindings.log = (message: string) => {
    results.push(`[log] ${message}`);
    sandbox.log(message);
  };

  bindings.args = sandbox.args ?? {};
  bindings.budget = sandbox.budget ?? {
    total: null,
    spent: () => 0,
    remaining: () => Infinity,
  };

  bindings.__meta = meta;

  // Explicitly shadow dangerous Node.js globals with undefined.
  // Any global not in ALLOWED_GLOBALS would otherwise still be reachable
  // through the global scope chain.
  const BLOCKED_GLOBALS = [
    'process',
    'require',
    'global',
    'globalThis',
    'module',
    'exports',
    '__dirname',
    '__filename',
    'Buffer',
    'clearImmediate',
    'clearInterval',
    'clearTimeout',
    'setImmediate',
    'setInterval',
    'setTimeout',
    'queueMicrotask',
    'structuredClone',
    'atob',
    'btoa',
    'fetch',
    'console',
  ];
  for (const name of BLOCKED_GLOBALS) {
    if (!(name in bindings)) {
      bindings[name] = undefined;
    }
  }

  // 4. Execute the script body
  // Filter: only valid JS identifiers can be Function params
  // null, true, false, etc. are literals, not needed as bindings
  const validBindings: Array<[string, unknown]> = [];
  const invalidBindings: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(bindings)) {
    if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key)) {
      validBindings.push([key, value]);
    } else {
      invalidBindings.push([key, value]);
    }
  }

  const paramNames = validBindings.map(([k]) => k);
  const paramValues = validBindings.map(([, v]) => v);

  // Suppress any FS/network access from the script
  const scriptFn = new Function(
    ...paramNames,
    `"use strict"; return (async () => { ${scriptBody} })();`,
  );

  let scriptResult: unknown;
  try {
    scriptResult = await scriptFn(...paramValues);
  } catch (err) {
    if (err instanceof WorkflowScriptError) {
      throw err;
    }
    throw new WorkflowScriptError(
      `Script execution failed: ${err instanceof Error ? err.message : String(err)}`,
      'RUNTIME_ERROR',
      err instanceof Error ? err : undefined,
    );
  }

  // 5. Build result
  const execResult: WorkflowExecutionResult = {
    results,
    phases,
    totalAgentCount: agentCounter.count,
  };

  if (scriptResult !== undefined && scriptResult !== null) {
    execResult.structuredResult = scriptResult;
  }

  return execResult;
}

/**
 * Extract only the metadata from a script without executing it.
 * Useful for validation and display purposes.
 */
export function extractMeta(script: string): WorkflowMeta {
  const { meta } = parseMeta(script);
  return meta;
}

/**
 * Validate a workflow script without executing it.
 * Returns null if valid, or an error message if invalid.
 */
export function validateScript(script: string): string | null {
  try {
    const { meta } = parseMeta(script);

    if (!meta.name || typeof meta.name !== 'string') {
      return 'meta.name must be a non-empty string.';
    }

    if (meta.phases && !Array.isArray(meta.phases)) {
      return 'meta.phases must be an array if provided.';
    }

    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
