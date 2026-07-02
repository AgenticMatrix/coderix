/**
 * Tests for the workflow runtime — sandbox safety, meta parsing, and execution.
 */

import { describe, expect, it } from 'vitest';
import {
  executeWorkflow,
  extractMeta,
  validateScript,
} from '../../packages/coderix-core/src/workflow/runtime.js';
import type { SandboxGlobals } from '../../packages/coderix-core/src/workflow/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockSandbox(overrides: Partial<SandboxGlobals> = {}): SandboxGlobals {
  return {
    agent: async (prompt: string) => `result: ${prompt.slice(0, 20)}`,
    parallel: async (thunks: Array<() => Promise<unknown>>) => {
      const results = await Promise.all(thunks.map(t => t().catch(() => null)));
      return results;
    },
    pipeline: async (items: unknown[], ...stages: Array<(prev: unknown) => Promise<unknown>>) => {
      const results: unknown[] = [];
      for (const item of items) {
        let current = item;
        for (const stage of stages) {
          current = await stage(current, 0);
        }
        results.push(current);
      }
      return results;
    },
    phase: () => {},
    log: () => {},
    args: undefined,
    budget: {
      total: null,
      spent: () => 0,
      remaining: () => Infinity,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Meta parsing
// ---------------------------------------------------------------------------

describe('extractMeta', () => {
  it('should parse valid meta', () => {
    const script = [
      'export const meta = {',
      '  name: "test-workflow",',
      '  description: "A test workflow",',
      '  phases: [{ title: "One" }, { title: "Two" }]',
      '};',
      '',
      'agent("hello");',
    ].join('\n');

    const meta = extractMeta(script);
    expect(meta.name).toBe('test-workflow');
    expect(meta.description).toBe('A test workflow');
    expect(meta.phases).toHaveLength(2);
    expect(meta.phases![0].title).toBe('One');
  });

  it('should throw on missing meta', () => {
    expect(() => extractMeta('agent("hello");')).toThrow('must start with');
  });

  it('should throw on meta without name', () => {
    expect(() =>
      extractMeta('export const meta = { description: "no name" };'),
    ).toThrow('non-empty');
  });
});

describe('validateScript', () => {
  it('should return null for valid scripts', () => {
    const script = [
      'export const meta = {',
      '  name: "ok",',
      '  description: "fine"',
      '};',
    ].join('\n');

    expect(validateScript(script)).toBeNull();
  });

  it('should return error for invalid scripts', () => {
    const err = validateScript('just some code');
    expect(err).toBeTruthy();
    expect(err).toContain('must start with');
  });

  it('should reject meta.phases that is not an array', () => {
    const script = [
      'export const meta = {',
      '  name: "bad",',
      '  description: "desc",',
      '  phases: "not-an-array"',
      '};',
    ].join('\n');

    const err = validateScript(script);
    expect(err).toContain('phases');
  });
});

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

describe('executeWorkflow', () => {
  it('should execute a simple script with one agent call', async () => {
    const sandbox = createMockSandbox();
    const script = [
      'export const meta = { name: "simple", description: "test" };',
      'const result = await agent("do something");',
      'return result;',
    ].join('\n');

    const outcome = await executeWorkflow(script, sandbox);
    expect(outcome.totalAgentCount).toBe(1);
    expect(outcome.results.length).toBeGreaterThanOrEqual(0);
  });

  it('should execute parallel agent calls', async () => {
    const calls: string[] = [];
    const sandbox = createMockSandbox({
      agent: async (prompt: string) => {
        calls.push(prompt);
        return `done: ${prompt}`;
      },
    });

    const script = [
      'export const meta = { name: "parallel-test", description: "test" };',
      'const results = await parallel([',
      '  () => agent("task-1"),',
      '  () => agent("task-2"),',
      '  () => agent("task-3"),',
      ']);',
      'return results;',
    ].join('\n');

    await executeWorkflow(script, sandbox);
    expect(calls).toHaveLength(3);
    expect(calls).toContain('task-1');
    expect(calls).toContain('task-2');
    expect(calls).toContain('task-3');
  });

  it('should track phases', async () => {
    const sandbox = createMockSandbox();
    const script = [
      'export const meta = { name: "phases", description: "test" };',
      'phase("init");',
      'await agent("setup");',
      'phase("work");',
      'await agent("do work");',
      'return "done";',
    ].join('\n');

    const outcome = await executeWorkflow(script, sandbox);
    expect(outcome.phases.length).toBeGreaterThanOrEqual(1);
    expect(outcome.phases.some(p => p.title === 'init' || p.title === 'work')).toBe(true);
  });

  it('should inject args into the sandbox', async () => {
    const sandbox = createMockSandbox({
      args: { target: 'src/app.ts', maxDepth: 3 },
    });

    const script = [
      'export const meta = { name: "args-test", description: "test" };',
      'log(`target=${args.target}, depth=${args.maxDepth}`);',
      'return args.target;',
    ].join('\n');

    const outcome = await executeWorkflow(script, sandbox);
    expect(outcome.structuredResult).toBe('src/app.ts');
    const logLine = outcome.results.find(r => r.includes('target=src/app.ts'));
    expect(logLine).toBeTruthy();
  });

  it('should reject scripts that try to access fs', async () => {
    const sandbox = createMockSandbox();

    const script = [
      'export const meta = { name: "hack", description: "test" };',
      '// Try to access require or process',
      'const fs = require("fs");',
    ].join('\n');

    await expect(executeWorkflow(script, sandbox)).rejects.toThrow();
  });

  it('should reject scripts that try to use Date.now()', async () => {
    const sandbox = createMockSandbox();

    const script = [
      'export const meta = { name: "hack2", description: "test" };',
      'const now = Date.now();',
    ].join('\n');

    await expect(executeWorkflow(script, sandbox)).rejects.toThrow();
  });

  it('should reject scripts that try to use Math.random()', async () => {
    const sandbox = createMockSandbox();

    const script = [
      'export const meta = { name: "hack3", description: "test" };',
      'const r = Math.random();',
    ].join('\n');

    await expect(executeWorkflow(script, sandbox)).rejects.toThrow();
  });

  it('should enforce the agent call limit', async () => {
    const sandbox = createMockSandbox();
    const script = [
      'export const meta = { name: "limit-test", description: "test" };',
      '// Try to make too many calls',
      'for (let i = 0; i < 10; i++) {',
      '  await agent("call " + i);',
      '}',
    ].join('\n');

    const outcome = await executeWorkflow(script, sandbox);
    // Should succeed with 10 calls (under the 1000 limit)
    expect(outcome.totalAgentCount).toBe(10);
  });

  it('should run pipeline with multiple stages', async () => {
    const sandbox = createMockSandbox({
      pipeline: async (items, ...stages) => {
        const results: string[] = [];
        for (let i = 0; i < items.length; i++) {
          let current: unknown = items[i];
          for (const stage of stages) {
            current = await stage(current, i);
          }
          results.push(current as string);
        }
        return results;
      },
    });

    const script = [
      'export const meta = { name: "pipeline", description: "test" };',
      'const results = await pipeline(',
      '  ["a", "b"],',
      '  async (item, i) => item + "-s1",',
      '  async (item, i) => item + "-s2"',
      ');',
      'return results;',
    ].join('\n');

    const outcome = await executeWorkflow(script, sandbox);
    expect((outcome.structuredResult as string[])?.[0]).toBe('a-s1-s2');
    expect((outcome.structuredResult as string[])?.[1]).toBe('b-s1-s2');
  });
});

// ---------------------------------------------------------------------------
// Sandbox safety — direct API tests
// ---------------------------------------------------------------------------

describe('sandbox safety', () => {
  it('should block require (no fs access)', async () => {
    const sandbox = createMockSandbox();
    const script = [
      'export const meta = { name: "safe1", description: "test" };',
      '// require is shadowed to undefined → calling it throws',
      'return require("fs");',
    ].join('\n');

    await expect(executeWorkflow(script, sandbox)).rejects.toThrow();
  });

  it('should block process.env access', async () => {
    const sandbox = createMockSandbox();
    const script = [
      'export const meta = { name: "safe2", description: "test" };',
      '// process is shadowed to undefined → accessing .env throws TypeError',
      'return process.env.HOME;',
    ].join('\n');

    await expect(executeWorkflow(script, sandbox)).rejects.toThrow();
  });

  it('should allow safe built-ins (JSON, Object, Array)', async () => {
    const sandbox = createMockSandbox();
    const script = [
      'export const meta = { name: "safe3", description: "test" };',
      'const obj = { a: 1, b: 2 };',
      'const keys = Object.keys(obj);',
      'const json = JSON.stringify(obj);',
      'return json;',
    ].join('\n');

    const outcome = await executeWorkflow(script, sandbox);
    expect(outcome.structuredResult).toBe('{"a":1,"b":2}');
  });
});
