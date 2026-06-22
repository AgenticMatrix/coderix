/**
 * ACP Slash Command interception tests.
 * Verifies that slash-prefixed inputs are detected and routed correctly.
 */

import { describe, it, expect } from 'vitest';
import { isSlashCommand, parseSlashCommand } from '../../src/commands/handler.js';
import { findSlashCommand, SLASH_COMMANDS } from '../../src/commands/registry.js';

describe('ACP Slash Command Detection', () => {
  describe('isSlashCommand', () => {
    it('should detect / prefixed input', () => {
      expect(isSlashCommand('/help')).toBe(true);
      expect(isSlashCommand('/memory status')).toBe(true);
      expect(isSlashCommand('/add-dir /tmp')).toBe(true);
    });

    it('should reject non-slash input', () => {
      expect(isSlashCommand('hello world')).toBe(false);
      expect(isSlashCommand('not a command')).toBe(false);
    });

    it('should handle empty input', () => {
      expect(isSlashCommand('')).toBe(false);
    });
  });

  describe('parseSlashCommand', () => {
    it('should extract name and arg', () => {
      const { name, arg } = parseSlashCommand('/memory status');
      expect(name).toBe('memory');
      expect(arg).toBe('status');
    });

    it('should handle no argument', () => {
      const { name, arg } = parseSlashCommand('/help');
      expect(name).toBe('help');
      expect(arg).toBe('');
    });

    it('should handle multiple spaces', () => {
      const { name, arg } = parseSlashCommand('/memory   view  foo');
      expect(name).toBe('memory');
      expect(arg).toBe('view  foo');
    });
  });

  describe('findSlashCommand', () => {
    it('should find /memory in registry', () => {
      const cmd = findSlashCommand('memory');
      expect(cmd).toBeDefined();
      expect(cmd!.name).toBe('memory');
    });

    it('should find /help in registry', () => {
      const cmd = findSlashCommand('help');
      expect(cmd).toBeDefined();
    });

    it('should find /add-dir in registry', () => {
      const cmd = findSlashCommand('add-dir');
      expect(cmd).toBeDefined();
      expect(cmd!.name).toBe('add-dir');
    });

    it('should return undefined for unknown commands', () => {
      expect(findSlashCommand('nonexistent-command')).toBeUndefined();
    });

    it('should match aliases', () => {
      const cmd = findSlashCommand('mem');
      expect(cmd).toBeDefined();
      expect(cmd!.name).toBe('memory');
    });
  });

  describe('slash command list completeness', () => {
    it('should have all required commands registered', () => {
      const names = SLASH_COMMANDS.map((c) => c.name);
      expect(names).toContain('help');
      expect(names).toContain('memory');
      expect(names).toContain('add-dir');
      expect(names).toContain('config');
      expect(names).toContain('tasks');
    });

    it('should have no duplicate names', () => {
      const names = SLASH_COMMANDS.map((c) => c.name);
      expect(new Set(names).size).toBe(names.length);
    });

    it('should have help text for every command', () => {
      for (const cmd of SLASH_COMMANDS) {
        expect(cmd.help).toBeTruthy();
      }
    });
  });
});
