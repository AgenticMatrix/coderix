/**
 * Tests for command-tokenizer.ts — shell command parsing and token extraction.
 */
import { describe, it, expect } from 'vitest';
import {
  tokenizeCommand,
  extractCommandTokens,
  extractCommandKey,
} from '../../../packages/coderix-core/src/tools/bash/command-tokenizer.js';

describe('tokenizeCommand', () => {
  it('should parse simple commands', () => {
    const result = tokenizeCommand('git diff --name-only');
    expect(result.success).toBe(true);
    expect(result.success && result.entries).toHaveLength(3);
  });

  it('should parse piped commands', () => {
    const result = tokenizeCommand('ls -la | grep foo');
    expect(result.success).toBe(true);
  });

  it('should parse commands with quotes', () => {
    const result = tokenizeCommand('echo "hello world"');
    expect(result.success).toBe(true);
    // shell-quote returns 2 entries: 'echo' and 'hello world'
    expect(result.success && result.entries).toHaveLength(2);
  });

  it('should parse commands with single quotes', () => {
    const result = tokenizeCommand("grep 'some pattern' file.txt");
    expect(result.success).toBe(true);
  });

  it('should parse heredoc commands', () => {
    const result = tokenizeCommand('cat <<EOF\nhello\nEOF');
    expect(result.success).toBe(true);
  });

  it('should parse commands with environment variables', () => {
    const result = tokenizeCommand('echo $HOME');
    expect(result.success).toBe(true);
  });

  it('should parse empty commands', () => {
    const result = tokenizeCommand('');
    expect(result.success).toBe(true);
  });

  it('should handle line continuations', () => {
    const result = tokenizeCommand('echo hello \\\nworld');
    expect(result.success).toBe(true);
  });
});

describe('extractCommandTokens', () => {
  it('should extract tokens from simple commands', () => {
    const result = tokenizeCommand('git diff --name-only');
    expect(result.success).toBe(true);
    if (!result.success) return;

    const tokens = extractCommandTokens(result.entries);
    expect(tokens).toEqual(['git', 'diff', '--name-only']);
  });

  it('should skip pipe operators', () => {
    const result = tokenizeCommand('ls -la | grep foo | wc -l');
    expect(result.success).toBe(true);
    if (!result.success) return;

    const tokens = extractCommandTokens(result.entries);
    expect(tokens).toEqual(['ls', '-la', 'grep', 'foo', 'wc', '-l']);
  });

  it('should skip && and || operators', () => {
    const result = tokenizeCommand('git add . && git commit -m "test"');
    expect(result.success).toBe(true);
    if (!result.success) return;

    const tokens = extractCommandTokens(result.entries);
    expect(tokens).toEqual(['git', 'add', '.', 'git', 'commit', '-m', 'test']);
  });

  it('should skip semicolon operator', () => {
    const result = tokenizeCommand('echo hello; echo world');
    expect(result.success).toBe(true);
    if (!result.success) return;

    const tokens = extractCommandTokens(result.entries);
    expect(tokens).toEqual(['echo', 'hello', 'echo', 'world']);
  });

  it('should skip redirect operators', () => {
    const result = tokenizeCommand('echo hello > out.txt');
    expect(result.success).toBe(true);
    if (!result.success) return;

    const tokens = extractCommandTokens(result.entries);
    expect(tokens).toContain('echo');
    expect(tokens).toContain('hello');
    expect(tokens).toContain('out.txt');
  });

  it('should handle quoted strings as single tokens', () => {
    const result = tokenizeCommand('git commit -m "fix: update config"');
    expect(result.success).toBe(true);
    if (!result.success) return;

    const tokens = extractCommandTokens(result.entries);
    expect(tokens).toContain('git');
    expect(tokens).toContain('commit');
    expect(tokens).toContain('-m');
    expect(tokens.some(t => t.includes('fix: update config'))).toBe(true);
  });

  it('should handle empty entry result', () => {
    const tokens = extractCommandTokens([]);
    expect(tokens).toEqual([]);
  });
});

describe('extractCommandKey', () => {
  it('should return single-word key for simple commands', () => {
    // Only flags (-*) break the subcommand chain
    expect(extractCommandKey(['ls', '-la'])).toBe('ls');
    // Non-flag tokens are treated as subcommands
    expect(extractCommandKey(['cat', 'file.txt'])).toBe('cat file.txt');
    expect(extractCommandKey(['echo', 'hello'])).toBe('echo hello');
  });

  it('should return two-word key for subcommand commands', () => {
    expect(extractCommandKey(['git', 'diff', '--name-only'])).toBe('git diff');
    expect(extractCommandKey(['git', 'log', '--oneline'])).toBe('git log');
    expect(extractCommandKey(['docker', 'ps', '-a'])).toBe('docker ps');
  });

  it('should handle single-token commands', () => {
    expect(extractCommandKey(['pwd'])).toBe('pwd');
  });

  it('should handle empty arrays', () => {
    expect(extractCommandKey([])).toBe('');
  });

  it('should skip environment variable assignments', () => {
    expect(extractCommandKey(['VAR=val', 'git', 'diff'])).toBe('git diff');
  });
});
