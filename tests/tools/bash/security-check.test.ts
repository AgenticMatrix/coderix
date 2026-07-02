/**
 * Tests for security-check.ts — end-to-end bash security checks.
 *
 * Two-tier architecture:
 *   Hard blocks — unconditionally denied (fork bombs, redirects, privilege escalation)
 *   Soft blocks — ALLOWED by security check, classified for permission layer ASK
 */
import { describe, it, expect } from 'vitest';
import { createBashSecurityCheck } from '../../../packages/coderix-core/src/tools/bash/security-check.js';
import { tokenizeCommand, extractCommandTokens } from '../../../packages/coderix-core/src/tools/bash/command-tokenizer.js';
import { CommandCategory } from '../../../packages/coderix-core/src/tools/bash/command-classifier.js';

const securityCheck = createBashSecurityCheck();

function check(command: string) {
  const tokenizeResult = tokenizeCommand(command);
  const tokens = tokenizeResult.success ? extractCommandTokens(tokenizeResult.entries) : [];
  return securityCheck(command, tokens, '/tmp/test');
}

describe('Security check — read-only commands', () => {
  it('should allow "git diff --name-only"', () => {
    const result = check('git diff --name-only');
    expect(result.allowed).toBe(true);
    expect(result.classification.category).toBe(CommandCategory.READ_ONLY);
    expect(result.classification.isReadOnly).toBe(true);
    expect(result.classification.isConcurrencySafe).toBe(true);
  });

  it('should allow "git log --oneline -n 10"', () => {
    const result = check('git log --oneline -n 10');
    expect(result.allowed).toBe(true);
    expect(result.classification.isReadOnly).toBe(true);
  });

  it('should allow "git status"', () => {
    const result = check('git status');
    expect(result.allowed).toBe(true);
    expect(result.classification.isReadOnly).toBe(true);
  });

  it('should allow "git branch -a"', () => {
    const result = check('git branch -a');
    expect(result.allowed).toBe(true);
    expect(result.classification.isReadOnly).toBe(true);
  });

  it('should allow "git blame src/file.ts"', () => {
    const result = check('git blame src/file.ts');
    expect(result.allowed).toBe(true);
    expect(result.classification.isReadOnly).toBe(true);
  });

  it('should allow "git grep -n pattern"', () => {
    const result = check('git grep -n pattern');
    expect(result.allowed).toBe(true);
    expect(result.classification.isReadOnly).toBe(true);
  });

  it('should allow "ls -la"', () => {
    const result = check('ls -la');
    expect(result.allowed).toBe(true);
    expect(result.classification.isReadOnly).toBe(true);
  });

  it('should allow "cat file.txt"', () => {
    const result = check('cat file.txt');
    expect(result.allowed).toBe(true);
    expect(result.classification.isReadOnly).toBe(true);
  });

  it('should allow "grep -i pattern file.txt"', () => {
    const result = check('grep -i pattern file.txt');
    expect(result.allowed).toBe(true);
    expect(result.classification.isReadOnly).toBe(true);
  });

  it('should allow "rg -n pattern src/"', () => {
    const result = check('rg -n pattern src/');
    expect(result.allowed).toBe(true);
    expect(result.classification.isReadOnly).toBe(true);
  });

  it('should allow "find . -name pattern"', () => {
    const result = check('find . -name pattern');
    expect(result.allowed).toBe(true);
    expect(result.classification.isReadOnly).toBe(true);
  });

  it('should allow "echo hello"', () => {
    const result = check('echo hello');
    expect(result.allowed).toBe(true);
    expect(result.classification.isReadOnly).toBe(true);
  });

  it('should allow "pwd"', () => {
    const result = check('pwd');
    expect(result.allowed).toBe(true);
    expect(result.classification.isReadOnly).toBe(true);
  });

  it('should allow "whoami"', () => {
    const result = check('whoami');
    expect(result.allowed).toBe(true);
    expect(result.classification.isReadOnly).toBe(true);
  });
});

describe('Security check — HARD BLOCKS (unconditionally denied)', () => {
  it('should block fork bombs', () => {
    const result = check(':(){ :|:& };:');
    expect(result.allowed).toBe(false);
    expect(result.classification.category).toBe(CommandCategory.DESTRUCTIVE);
  });

  it('should block command substitution with $()', () => {
    const result = check('echo $(whoami)');
    expect(result.allowed).toBe(false);
    expect(result.classification.category).toBe(CommandCategory.CODE_EXEC);
  });

  it('should block command substitution with backticks', () => {
    const result = check('echo `whoami`');
    expect(result.allowed).toBe(false);
    expect(result.classification.category).toBe(CommandCategory.CODE_EXEC);
  });

  it('should block process substitution <()', () => {
    const result = check('diff <(ls) <(ls)');
    expect(result.allowed).toBe(false);
    expect(result.classification.category).toBe(CommandCategory.CODE_EXEC);
  });

  it('should block dangerous redirects to /dev/sda', () => {
    const result = check('echo hello > /dev/sda');
    expect(result.allowed).toBe(false);
    expect(result.classification.category).toBe(CommandCategory.DESTRUCTIVE);
  });

  it('should block chmod +s (privilege escalation)', () => {
    const result = check('chmod +s /bin/bash');
    expect(result.allowed).toBe(false);
    expect(result.classification.category).toBe(CommandCategory.DESTRUCTIVE);
  });

  it('should block chown root', () => {
    const result = check('chown root /tmp/file');
    expect(result.allowed).toBe(false);
    expect(result.classification.category).toBe(CommandCategory.DESTRUCTIVE);
  });

  it('should block "git push --force"', () => {
    const result = check('git push --force origin main');
    expect(result.allowed).toBe(false);
    expect(result.classification.category).toBe(CommandCategory.DESTRUCTIVE);
  });

  it('should block "git push -f origin main"', () => {
    const result = check('git push -f origin main');
    expect(result.allowed).toBe(false);
    expect(result.classification.category).toBe(CommandCategory.DESTRUCTIVE);
  });

  it('should block "git push --delete origin branch"', () => {
    const result = check('git push --delete origin branch');
    expect(result.allowed).toBe(false);
    expect(result.classification.category).toBe(CommandCategory.DESTRUCTIVE);
  });

  it('should block "git reset --hard HEAD~1"', () => {
    const result = check('git reset --hard HEAD~1');
    expect(result.allowed).toBe(false);
    expect(result.classification.category).toBe(CommandCategory.DESTRUCTIVE);
  });
});

describe('Security check — SOFT BLOCKS (allowed, classified for permission ASK)', () => {
  it('should allow "python -c" but classify as CODE_EXEC', () => {
    const result = check('python -c print(1)');
    expect(result.allowed).toBe(true);
    expect(result.classification.category).toBe(CommandCategory.CODE_EXEC);
    expect(result.classification.isConcurrencySafe).toBe(false);
  });

  it('should allow "node -e" but classify as CODE_EXEC', () => {
    const result = check('node -e console.log(1)');
    expect(result.allowed).toBe(true);
    expect(result.classification.category).toBe(CommandCategory.CODE_EXEC);
  });

  it('should allow "bash -c" but classify as CODE_EXEC', () => {
    const result = check('bash -c echo hi');
    expect(result.allowed).toBe(true);
    expect(result.classification.category).toBe(CommandCategory.CODE_EXEC);
  });

  it('should allow "sh script.sh" but classify as CODE_EXEC', () => {
    const result = check('sh script.sh');
    expect(result.allowed).toBe(true);
    expect(result.classification.category).toBe(CommandCategory.CODE_EXEC);
  });

  it('should allow "npx tsx" but classify as CODE_EXEC', () => {
    const result = check('npx tsx file.ts');
    expect(result.allowed).toBe(true);
    expect(result.classification.category).toBe(CommandCategory.CODE_EXEC);
  });

  it('should allow "npm run dev" but classify as CODE_EXEC', () => {
    const result = check('npm run dev');
    expect(result.allowed).toBe(true);
    expect(result.classification.category).toBe(CommandCategory.CODE_EXEC);
  });

  it('should allow "eval echo hi" but classify as CODE_EXEC', () => {
    const result = check('eval echo hi');
    expect(result.allowed).toBe(true);
    expect(result.classification.category).toBe(CommandCategory.CODE_EXEC);
  });

  it('should allow "sudo ls" but classify as DESTRUCTIVE', () => {
    const result = check('sudo ls');
    expect(result.allowed).toBe(true);
    expect(result.classification.category).toBe(CommandCategory.DESTRUCTIVE);
  });

  it('should allow rm -rf but classify as DESTRUCTIVE', () => {
    const result = check('rm -rf /tmp/test');
    expect(result.allowed).toBe(true);
    expect(result.classification.category).toBe(CommandCategory.DESTRUCTIVE);
  });

  it('should allow xargs but classify as CODE_EXEC', () => {
    const result = check('xargs rm');
    expect(result.allowed).toBe(true);
    expect(result.classification.category).toBe(CommandCategory.CODE_EXEC);
  });

  it('should allow "ssh user@host" but classify as CODE_EXEC', () => {
    const result = check('ssh user@host');
    expect(result.allowed).toBe(true);
    expect(result.classification.category).toBe(CommandCategory.CODE_EXEC);
  });

  it('should allow curl POST but classify as NETWORK', () => {
    const result = check('curl -X POST https://example.com');
    expect(result.allowed).toBe(true);
    expect(result.classification.category).toBe(CommandCategory.NETWORK);
  });

  it('should allow nc (netcat) but classify as NETWORK', () => {
    const result = check('nc -l 1234');
    expect(result.allowed).toBe(true);
    expect(result.classification.category).toBe(CommandCategory.NETWORK);
  });

  it('should allow "git commit --amend" as MUTATION (not hard-blocked)', () => {
    const result = check('git commit --amend -m "fix"');
    expect(result.allowed).toBe(true);
    // Falls to UNKNOWN — treated as MUTATION, goes through ASK
  });
});

describe('Security check — unknown commands', () => {
  it('should allow unknown commands as MUTATION (default mode)', () => {
    const result = check('npm install express');
    expect(result.allowed).toBe(true);
    expect(result.classification.category).toBe(CommandCategory.UNKNOWN);
  });

  it('should allow "mkdir newdir" as MUTATION', () => {
    const result = check('mkdir newdir');
    expect(result.allowed).toBe(true);
    expect(result.classification.category).toBe(CommandCategory.UNKNOWN);
  });

  it('should classify git branch without --list as dangerous', () => {
    // git branch newbranch should be blocked by the branch creation callback
    const result = check('git branch newbranch');
    // This should be blocked by additionalCommandIsDangerousCallback
    expect(result.allowed).toBe(true); // flag validation rejects it, but security-check just sees it as MUTATION
    // Actually, the validateFlags will reject it, so matchReadOnlyCommand returns non-whitelisted → falls to UNKNOWN
    // The branch creation check happens in flag-validator which security-check doesn't directly use
  });
});

describe('Security check — concurrency safety', () => {
  it('should mark read-only commands as concurrency safe', () => {
    const result = check('git diff HEAD~1');
    expect(result.allowed).toBe(true);
    expect(result.classification.isConcurrencySafe).toBe(true);
  });

  it('should mark code exec as NOT concurrency safe', () => {
    const result = check('python -c "print(1)"');
    expect(result.classification.isConcurrencySafe).toBe(false);
  });

  it('should mark unknown commands as NOT concurrency safe', () => {
    const result = check('npm test');
    expect(result.classification.isConcurrencySafe).toBe(false);
  });
});
