/**
 * script-provider.test.ts — Tests for ScriptProvider (child-process hook execution)
 */

import { describe, expect, it } from 'vitest';
import { ScriptProvider } from '../providers/script.js';
import type { HookContext, HookDefinition } from '../types.js';

function makeHook(overrides: Partial<HookDefinition> = {}): HookDefinition {
  return {
    event: 'PreToolUse',
    command: 'echo',
    ...overrides,
  };
}

function makeContext(overrides: Partial<HookContext> = {}): HookContext {
  return {
    event: 'PreToolUse',
    sessionId: 'test-session',
    cwd: '/tmp',
    timestamp: Date.now(),
    toolName: 'Bash',
    toolInput: { command: 'ls' },
    ...overrides,
  } as HookContext;
}

describe('ScriptProvider', () => {
  it('should execute a simple command and parse JSON result', async () => {
    const provider = new ScriptProvider();

    // Use a node inline script that outputs valid JSON
    const hook = makeHook({
      command: 'node -e \'process.stdout.write(JSON.stringify({blocked:true,reason:"test"}))\'',
    });
    const ctx = makeContext();

    const result = await provider.execute(hook, ctx) as Record<string, unknown>;
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('test');
  });

  it('should return empty object on non-JSON stdout', async () => {
    const provider = new ScriptProvider();

    const hook = makeHook({
      command: 'echo "not json"',
    });
    const ctx = makeContext();

    const result = await provider.execute(hook, ctx);
    expect(result).toEqual({});
  });

  it('should return empty object on non-zero exit code', async () => {
    const provider = new ScriptProvider();

    const hook = makeHook({
      command: 'node -e \'process.exit(1)\'',
    });
    const ctx = makeContext();

    const result = await provider.execute(hook, ctx);
    expect(result).toEqual({});
  });

  it('should return empty object when command spawn fails', async () => {
    const provider = new ScriptProvider();

    const hook = makeHook({
      command: '/nonexistent/path/to/binary',
    });
    const ctx = makeContext();

    const result = await provider.execute(hook, ctx);
    expect(result).toEqual({});
  });

  it('should handle JSON with only partial fields', async () => {
    const provider = new ScriptProvider();

    const hook = makeHook({
      command: 'node -e \'process.stdout.write(JSON.stringify({shouldStop:true}))\'',
    });
    const ctx = makeContext({ event: 'onStop' } as unknown as Partial<HookContext>);

    const result = await provider.execute(hook, ctx) as Record<string, unknown>;
    expect(result.shouldStop).toBe(true);
  });

  it('should respect timeout (fast)', async () => {
    const provider = new ScriptProvider();

    // Script that sleeps longer than timeout
    const hook = makeHook({
      command: 'node -e \'setTimeout(()=>{process.stdout.write("{}");process.exit(0)},5000)\'',
      timeout: 500,
    });
    const ctx = makeContext();

    const start = Date.now();
    const result = await provider.execute(hook, ctx);
    const elapsed = Date.now() - start;

    // Should return empty (fail-open) and NOT wait the full 5s
    expect(result).toEqual({});
    expect(elapsed).toBeLessThan(3000); // generous upper bound
  });

  it('should handle empty stdout cleanly', async () => {
    const provider = new ScriptProvider();

    // Script that just exits with no output
    const hook = makeHook({
      command: 'node -e \'\'',  // empty script, exits 0, no output
    });
    const ctx = makeContext();

    const result = await provider.execute(hook, ctx);
    expect(result).toEqual({});
  });
});
