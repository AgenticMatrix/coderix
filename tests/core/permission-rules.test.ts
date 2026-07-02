/**
 * Tests for permission-rules.ts — rule matching and priority logic.
 */
import { describe, it, expect } from 'vitest';
import { PermissionRuleEngine } from '../../packages/coderix-core/src/core/permission-rules.js';
import type { PermissionRule } from '../../packages/coderix-core/src/core/permission-rules.js';

describe('PermissionRuleEngine', () => {
  describe('rule matching', () => {
    it('should match exact tool name (no content)', () => {
      const engine = new PermissionRuleEngine([
        { toolName: 'bash', behavior: 'allow', source: 'userSettings' },
      ]);

      const result = engine.evaluate('bash');
      expect(result).toBeDefined();
      expect(result!.behavior).toBe('approve');
      expect(result!.allowed).toBe(true);
    });

    it('should match tool name case-insensitively', () => {
      const engine = new PermissionRuleEngine([
        { toolName: 'bash', behavior: 'allow', source: 'userSettings' },
      ]);

      const result = engine.evaluate('Bash');
      expect(result).toBeDefined();
      expect(result!.allowed).toBe(true);
    });

    it('should match exact command content', () => {
      const engine = new PermissionRuleEngine([
        { toolName: 'bash', ruleContent: 'ls -la', behavior: 'deny', source: 'userSettings' },
      ]);

      const result = engine.evaluate('bash', 'ls -la');
      expect(result).toBeDefined();
      expect(result!.behavior).toBe('deny');
      expect(result!.allowed).toBe(false);
    });

    it('should match prefix wildcard (git:*)', () => {
      const engine = new PermissionRuleEngine([
        { toolName: 'bash', ruleContent: 'git:*', behavior: 'allow', source: 'userSettings' },
      ]);

      const result = engine.evaluate('bash', 'git diff');
      expect(result).toBeDefined();
      expect(result!.behavior).toBe('approve');
      expect(result!.allowed).toBe(true);
    });

    it('should match prefix wildcard with exact prefix also', () => {
      const engine = new PermissionRuleEngine([
        { toolName: 'bash', ruleContent: 'git:*', behavior: 'allow', source: 'userSettings' },
      ]);

      // Exact match on prefix
      const result = engine.evaluate('bash', 'git');
      expect(result).toBeDefined();
      expect(result!.behavior).toBe('approve');
    });

    it('should not match prefix wildcard when content differs', () => {
      const engine = new PermissionRuleEngine([
        { toolName: 'bash', ruleContent: 'git:*', behavior: 'allow', source: 'userSettings' },
      ]);

      const result = engine.evaluate('bash', 'npm install');
      expect(result).toBeUndefined();
    });

    it('should not match content rule when no content provided', () => {
      const engine = new PermissionRuleEngine([
        { toolName: 'bash', ruleContent: 'git:*', behavior: 'allow', source: 'userSettings' },
      ]);

      const result = engine.evaluate('bash');
      expect(result).toBeUndefined();
    });

    it('should return undefined when no rules match', () => {
      const engine = new PermissionRuleEngine();
      const result = engine.evaluate('bash');
      expect(result).toBeUndefined();
    });
  });

  describe('rule priority', () => {
    it('should prioritize deny over allow (same source)', () => {
      const engine = new PermissionRuleEngine([
        { toolName: 'bash', behavior: 'allow', source: 'userSettings' },
        { toolName: 'bash', behavior: 'deny', source: 'userSettings' },
      ]);

      const result = engine.evaluate('bash');
      expect(result).toBeDefined();
      expect(result!.behavior).toBe('deny');
      expect(result!.allowed).toBe(false);
    });

    it('should prioritize higher source', () => {
      const engine = new PermissionRuleEngine([
        { toolName: 'bash', behavior: 'allow', source: 'projectSettings' },
        { toolName: 'bash', behavior: 'deny', source: 'cliArg' },
      ]);

      const result = engine.evaluate('bash');
      expect(result).toBeDefined();
      // cliArg has higher priority, so deny wins
      expect(result!.behavior).toBe('deny');
    });

    it('should prioritize specific rules over general rules', () => {
      const engine = new PermissionRuleEngine([
        { toolName: 'bash', behavior: 'deny', source: 'userSettings' },
        { toolName: 'bash', ruleContent: 'git diff', behavior: 'allow', source: 'userSettings' },
      ]);

      // Command-specific rule wins for "git diff"
      const result = engine.evaluate('bash', 'git diff');
      expect(result).toBeDefined();
      expect(result!.behavior).toBe('approve');
    });
  });

  describe('rule management', () => {
    it('should add rules', () => {
      const engine = new PermissionRuleEngine();
      engine.addRule({ toolName: 'bash', behavior: 'deny', source: 'userSettings' });

      const result = engine.evaluate('bash');
      expect(result).toBeDefined();
      expect(result!.behavior).toBe('deny');
    });

    it('should remove rules by tool name and content', () => {
      const engine = new PermissionRuleEngine([
        { toolName: 'bash', ruleContent: 'rm:*', behavior: 'deny', source: 'userSettings' },
      ]);

      engine.removeRule('bash', 'rm:*');
      const result = engine.evaluate('bash', 'rm -rf');
      expect(result).toBeUndefined();
    });

    it('should clear all rules', () => {
      const engine = new PermissionRuleEngine([
        { toolName: 'bash', behavior: 'deny', source: 'userSettings' },
      ]);

      engine.clearRules();
      const result = engine.evaluate('bash');
      expect(result).toBeUndefined();
    });

    it('should list rules', () => {
      const rules: PermissionRule[] = [
        { toolName: 'bash', behavior: 'deny', source: 'userSettings' },
      ];
      const engine = new PermissionRuleEngine(rules);

      expect(engine.getRules()).toEqual(rules);
    });
  });

  describe('ask behavior', () => {
    it('should return ask_user behavior with prompt', () => {
      const engine = new PermissionRuleEngine([
        { toolName: 'bash', ruleContent: 'rm:*', behavior: 'ask', source: 'userSettings' },
      ]);

      const result = engine.evaluate('bash', 'rm file.txt');
      expect(result).toBeDefined();
      expect(result!.behavior).toBe('ask_user');
      expect(result!.prompt).toBeDefined();
      expect(result!.prompt).toContain('bash');
      expect(result!.prompt).toContain('rm:*');
    });

    it('should use allow behavior correctly', () => {
      const engine = new PermissionRuleEngine([
        { toolName: 'bash', ruleContent: 'git:*', behavior: 'allow', source: 'userSettings' },
      ]);

      const result = engine.evaluate('bash', 'git status');
      expect(result).toBeDefined();
      expect(result!.behavior).toBe('approve');
      expect(result!.allowed).toBe(true);
    });
  });

  describe('reason tracking', () => {
    it('should include rule info in reason', () => {
      const engine = new PermissionRuleEngine([
        { toolName: 'bash', ruleContent: 'rm:*', behavior: 'deny', source: 'userSettings' },
      ]);

      const result = engine.evaluate('bash', 'rm -rf /tmp/test');
      expect(result).toBeDefined();
      expect(result!.reason).toBeDefined();
      expect(result!.reason!.type).toBe('rule_match');
      if (result!.reason!.type === 'rule_match') {
        expect(result!.reason!.rule.toolName).toBe('bash');
        expect(result!.reason!.rule.ruleContent).toBe('rm:*');
        expect(result!.reason!.matchedPattern).toBe('rm:*');
      }
    });
  });
});
