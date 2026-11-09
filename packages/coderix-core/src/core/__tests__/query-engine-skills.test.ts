import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueryEngine } from '../query-engine.js';
import { SessionManager } from '../session.js';
import { ToolRegistry } from '../tool-registry.js';
import type { AssemblyContext, SystemPrompt } from '../system-prompt.js';

async function* emptyModel(): AsyncGenerator<never> {
  return;
}

/** Records the skill filter every prompt rebuild was assembled with. */
function capturingAssembler() {
  const seen: Array<string[] | undefined> = [];
  const assembler = {
    assemble: async (ctx: AssemblyContext): Promise<SystemPrompt> => {
      seen.push(ctx.skillFilter);
      return { prompt: '', parts: [] };
    },
  };
  return { assembler, seen };
}

function makeEngine(
  cwd: string,
  opts: { skills?: string[]; agentSkills?: string[] },
) {
  const sessionManager = new SessionManager(true, 'desktop');
  sessionManager.create({ title: 'test', cwd, model: 'test-model' });
  const { assembler, seen } = capturingAssembler();
  const engine = new QueryEngine({
    cwd,
    toolRegistry: new ToolRegistry(),
    sessionManager,
    model: 'test-model',
    callModel: emptyModel as never,
    settings: {},
    systemPromptAssembler: assembler as never,
    skills: opts.skills,
    agentSkills: opts.agentSkills,
  });
  return { engine, seen };
}

describe('QueryEngine — skill selection', () => {
  it('unions the session selection with the bound agent’s skills', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'coderix-skills-'));
    try {
      const { engine, seen } = makeEngine(cwd, {
        skills: ['research-papers'],
        agentSkills: ['cad', 'cad-viewer'],
      });

      await engine.init();

      expect(seen.at(-1)).toEqual(['research-papers', 'cad', 'cad-viewer']);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  // The desktop syncs the session's persisted selection on every turn. Before
  // this fix that overwrote the whole filter, so a plugin session (cad-harness)
  // silently lost every skill its manifest declares.
  it('keeps agent skills after setSkills() replaces the session selection', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'coderix-skills-'));
    try {
      const { engine, seen } = makeEngine(cwd, {
        skills: ['cad', 'cad-viewer'],
        agentSkills: ['cad', 'cad-viewer', 'urdf'],
      });
      await engine.init();

      // A turn syncs only what the session persisted.
      engine.setSkills(['research-papers']);
      await engine.init();

      expect(seen.at(-1)).toEqual(['research-papers', 'cad', 'cad-viewer', 'urdf']);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('still honors an explicit empty selection when the agent declares no skills', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'coderix-skills-'));
    try {
      const { engine, seen } = makeEngine(cwd, { skills: [] });
      await engine.init();

      // Empty array = "no skills enabled", not "no filter".
      expect(seen.at(-1)).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('leaves the filter undefined when no selection was made (CLI behaviour)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'coderix-skills-'));
    try {
      const { engine, seen } = makeEngine(cwd, {});
      await engine.init();

      // Undefined keeps the assembler injecting every discoverable skill.
      expect(seen.at(-1)).toBeUndefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});