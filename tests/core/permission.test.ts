import { describe, expect, it, beforeEach } from 'vitest';
import { PermissionEngine } from '../../packages/coderix-core/src/core/permission.js';
import { PermissionMode, RiskLevel } from '../../packages/coderix-core/src/core/types.js';

describe('PermissionEngine', () => {
  let engine: PermissionEngine;

  beforeEach(() => {
    engine = new PermissionEngine('/tmp/test');
  });

  describe('AUTO mode', () => {
    beforeEach(() => {
      engine.setMode(PermissionMode.AUTO);
    });

    it('should approve safe operations', async () => {
      const result = await engine.check({
        toolName: 'Read', input: {}, riskLevel: RiskLevel.SAFE,
      });
      expect(result.allowed).toBe(true);
      expect(result.behavior).toBe('approve');
    });

    it('should approve destructive operations', async () => {
      const result = await engine.check({
        toolName: 'Bash', input: {}, riskLevel: RiskLevel.DESTRUCTIVE,
      });
      expect(result.allowed).toBe(true);
    });
  });

  describe('PLAN mode', () => {
    beforeEach(() => {
      engine.setMode(PermissionMode.PLAN);
    });

    it('should approve safe operations', async () => {
      const result = await engine.check({
        toolName: 'Read', input: {}, riskLevel: RiskLevel.SAFE,
      });
      expect(result.allowed).toBe(true);
    });

    it('should deny mutation operations', async () => {
      const result = await engine.check({
        toolName: 'Write', input: {}, riskLevel: RiskLevel.MUTATION,
      });
      expect(result.allowed).toBe(false);
      expect(result.behavior).toBe('deny');
    });

    it('should deny destructive operations', async () => {
      const result = await engine.check({
        toolName: 'Bash', input: {}, riskLevel: RiskLevel.DESTRUCTIVE,
      });
      expect(result.allowed).toBe(false);
    });
  });

  describe('ASK mode', () => {
    beforeEach(() => {
      engine.setMode(PermissionMode.ASK);
    });

    it('should require confirmation for any operation', async () => {
      const result = await engine.check({
        toolName: 'Read', input: {}, riskLevel: RiskLevel.SAFE,
      });
      expect(result.allowed).toBe(false);
      expect(result.behavior).toBe('ask_user');
      expect(result.prompt).toContain('Read');
    });
  });

  describe('LOW mode (acceptEdits)', () => {
    beforeEach(() => {
      engine.setMode(PermissionMode.LOW);
    });

    it('should approve safe operations', async () => {
      const result = await engine.check({
        toolName: 'Read', input: {}, riskLevel: RiskLevel.SAFE,
      });
      expect(result.allowed).toBe(true);
      expect(result.behavior).toBe('approve');
    });

    it('should auto-approve edit tools', async () => {
      for (const toolName of ['Write', 'Update', 'NotebookEdit']) {
        const result = await engine.check({
          toolName, input: {}, riskLevel: RiskLevel.MUTATION,
        });
        expect(result.allowed).toBe(true);
        expect(result.behavior).toBe('approve');
      }
    });

    it('should auto-approve filesystem bash commands', async () => {
      for (const command of ['mkdir -p foo', 'touch a.txt', 'cp a b', 'sed -i s/x/y/ f']) {
        const result = await engine.check({
          toolName: 'Bash', input: { command }, riskLevel: RiskLevel.MUTATION,
        });
        expect(result.allowed).toBe(true);
        expect(result.behavior).toBe('approve');
      }
    });

    it('should still ask for rm and mv', async () => {
      for (const command of ['rm -rf foo', 'mv a b']) {
        const result = await engine.check({
          toolName: 'Bash', input: { command }, riskLevel: RiskLevel.DESTRUCTIVE,
        });
        expect(result.allowed).toBe(false);
        expect(result.behavior).toBe('ask_user');
      }
    });

    it('should approve compound commands via filesystem subcommand', async () => {
      const result = await engine.check({
        toolName: 'Bash', input: { command: 'mkdir a && curl http://example.com' }, riskLevel: RiskLevel.DESTRUCTIVE,
      });
      expect(result.allowed).toBe(true);
      expect(result.behavior).toBe('approve');
    });

    it('should still ask for non-filesystem mutation commands', async () => {
      const result = await engine.check({
        toolName: 'Bash', input: { command: 'git push' }, riskLevel: RiskLevel.MUTATION,
      });
      expect(result.allowed).toBe(false);
      expect(result.behavior).toBe('ask_user');
    });
  });

  describe('mode management', () => {
    it('should track current mode', () => {
      engine.setMode(PermissionMode.AUTO);
      expect(engine.getMode()).toBe(PermissionMode.AUTO);

      engine.setMode(PermissionMode.PLAN);
      expect(engine.getMode()).toBe(PermissionMode.PLAN);
    });

    it('should default to ASK mode', () => {
      expect(engine.getMode()).toBe(PermissionMode.ASK);
    });
  });

  describe('cwd management', () => {
    it('should track working directory', () => {
      engine.setCwd('/new/path');
      expect(engine.getMode()).toBe(PermissionMode.ASK); // mode unchanged
    });
  });
});
