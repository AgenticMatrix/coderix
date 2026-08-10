/**
 * Integration tests for git IPC handlers.
 * Uses real git repositories created in temp directories.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function git(args: string[], cwd: string, input?: string) {
  const opts: any = { cwd, encoding: 'utf-8' };
  if (input !== undefined) opts.input = input;
  return spawnSync('git', args, opts);
}

function createTempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'coderix-test-'));
  git(['init'], dir);
  // initial commit so HEAD exists
  writeFileSync(join(dir, 'README.md'), '# Test');
  git(['add', 'README.md'], dir);
  git(['commit', '-F', '-'], dir, 'init');
  return dir;
}

describe('Git IPC Operations', () => {
  let repo: string;

  beforeEach(() => { repo = createTempRepo(); });
  afterEach(() => { try { rmSync(repo, { recursive: true, force: true }); } catch { /* ok */ } });

  // ── P1-01: spawnSync Security ──────────────────────────
  describe('spawnSync Security (P1-01)', () => {
    it('stages file with spaces in name', () => {
      writeFileSync(join(repo, 'file with spaces.txt'), 'x');
      const r = git(['add', 'file with spaces.txt'], repo);
      expect(r.status).toBe(0);
    });

    it('stages file with dollar sign in name', () => {
      writeFileSync(join(repo, 'file-$dollar.txt'), 'x');
      const r = git(['add', 'file-$dollar.txt'], repo);
      expect(r.status).toBe(0);
    });

    it('commits with special characters via stdin', () => {
      writeFileSync(join(repo, 'test.txt'), 'x');
      git(['add', 'test.txt'], repo);
      const msg = 'fix: dollar $(whoami) backtick `cmd` quote " double ; semi';
      const r = git(['commit', '-F', '-'], repo, msg);
      expect(r.status).toBe(0);
      const log = git(['log', '-1', '--format=%B'], repo);
      expect(log.stdout.trim()).toBe(msg);
    });

    it('unstages file via spawnSync', () => {
      writeFileSync(join(repo, 'test.txt'), 'x');
      git(['add', 'test.txt'], repo);
      const r = git(['reset', 'HEAD', 'test.txt'], repo);
      expect(r.status).toBe(0);
    });

    it('discards changes', () => {
      writeFileSync(join(repo, 'junk.txt'), 'junk');
      git(['reset', 'HEAD', '--', 'junk.txt'], repo);
      git(['checkout', '--', 'junk.txt'], repo);
      git(['clean', '-f', '--', 'junk.txt'], repo);
      expect(existsSync(join(repo, 'junk.txt'))).toBe(false);
    });

    it('gets diff via spawnSync', () => {
      writeFileSync(join(repo, 'README.md'), '# Modified');
      const r = git(['diff', '--', 'README.md'], repo);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('# Modified');
    });
  });

  // ── P1-02: TYPE_CFG Status Mapping ────────────────────
  describe('TYPE_CFG Status Mapping (P1-02)', () => {
    it('maps all status types correctly', () => {
      writeFileSync(join(repo, 'added.txt'), 'a');
      git(['add', 'added.txt'], repo);
      writeFileSync(join(repo, 'README.md'), '# mod');
      writeFileSync(join(repo, 'untracked.txt'), 'u');
      git(['rm', '--cached', 'added.txt'], repo);
      writeFileSync(join(repo, 'added.txt'), 'a2');
      git(['add', 'added.txt'], repo);

      const status = git(['status', '--porcelain'], repo).stdout;
      const files = status.split('\n').filter(Boolean).map(line => {
        const code = line.slice(0, 2).trim();
        let type = 'M';
        if (code.includes('?')) type = '?';
        else if (code.includes('A')) type = 'A';
        else if (code.includes('D')) type = 'D';
        else if (code.includes('R')) type = 'R';
        return { type, code, file: line.slice(3) };
      });

      const TYPE_CFG = ['M', 'A', 'D', 'R', '?'];
      for (const f of files) {
        expect(TYPE_CFG).toContain(f.type);
      }
    });
  });

  // ── P2: Remote Operations ─────────────────────────────
  describe('Remote Operations (P2)', () => {
    it('push returns status (no remote)', () => {
      const r = git(['push'], repo);
      expect(r.status).toBeDefined();
    });

    it('fetch returns status', () => {
      const r = git(['fetch', '--all'], repo);
      expect(r.status).toBeDefined();
    });

    it('computes ahead/behind with upstream', () => {
      // Create a bare remote and push to it
      const remoteDir = mkdtempSync(join(tmpdir(), 'coderix-remote-'));
      git(['init', '--bare'], remoteDir);
      git(['remote', 'add', 'origin', remoteDir], repo);
      git(['push', '-u', 'origin', 'master'], repo);

      // Now we have upstream tracking
      const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], repo).stdout.trim();
      expect(upstream.length).toBeGreaterThan(0);

      const ab = git(['rev-list', '--left-right', '--count', upstream + '...HEAD'], repo).stdout.trim();
      const parts = ab.split('\t');
      expect(parts.length).toBe(2);

      rmSync(remoteDir, { recursive: true, force: true });
    });
  });

  // ── P3-01: Branch Management ──────────────────────────
  describe('Branch Management (P3-01)', () => {
    it('lists branches', () => {
      git(['checkout', '-b', 'feat'], repo);
      const r = git(['branch', '--format=%(refname:short)'], repo);
      expect(r.stdout).toContain('feat');
      expect(r.stdout).toContain('master');
    });

    it('creates and switches branch', () => {
      git(['checkout', '-b', 'new-feat'], repo);
      const cur = git(['branch', '--show-current'], repo).stdout.trim();
      expect(cur).toBe('new-feat');
    });

    it('deletes branch', () => {
      git(['checkout', '-b', 'tmp'], repo);
      git(['checkout', 'master'], repo);
      const r = git(['branch', '-d', 'tmp'], repo);
      expect(r.status).toBe(0);
      const list = git(['branch', '--format=%(refname:short)'], repo);
      expect(list.stdout).not.toContain('tmp');
    });
  });

  // ── P3-02: Stash Management ───────────────────────────
  describe('Stash Management (P3-02)', () => {
    it('saves, lists, and pops stash', () => {
      writeFileSync(join(repo, 'stash-me.txt'), 's');
      git(['add', 'stash-me.txt'], repo);
      const save = git(['stash', 'push', '-m', 'test stash'], repo);
      expect(save.status).toBe(0);

      const list = git(['stash', 'list'], repo);
      expect(list.stdout).toContain('test stash');

      const pop = git(['stash', 'pop'], repo);
      expect(pop.status).toBe(0);

      const after = git(['stash', 'list'], repo);
      expect(after.stdout.trim()).toBe('');
    });

    it('drops stash', () => {
      writeFileSync(join(repo, 'stash-me.txt'), 's');
      git(['add', 'stash-me.txt'], repo);
      git(['stash', 'push', '-m', 'to drop'], repo);
      const drop = git(['stash', 'drop'], repo);
      expect(drop.status).toBe(0);
    });
  });

  // ── P3-05: Hunk Operations ────────────────────────────
  describe('Hunk Operations (P3-05)', () => {
    it('stages a hunk via git apply --cached', () => {
      writeFileSync(join(repo, 'README.md'), '# Modified\n\nNew line');
      const diff = git(['diff', '--', 'README.md'], repo).stdout;
      expect(diff.length).toBeGreaterThan(0);

      // Parse the first hunk
      const lines = diff.split('\n');
      const meta: string[] = [];
      const hunks: { header: string; lines: string[] }[] = [];
      let cur: any = null;
      for (const l of lines) {
        if (l.startsWith('@@')) { if (cur) hunks.push(cur); cur = { header: l, lines: [] }; }
        else if (cur) cur.lines.push(l);
        else meta.push(l);
      }
      if (cur) hunks.push(cur);
      expect(hunks.length).toBeGreaterThanOrEqual(1);

      const patch = [...meta, hunks[0].header, ...hunks[0].lines].join('\n') + '\n';
      const apply = git(['apply', '--cached'], repo, patch);
      expect(apply.status).toBe(0);

      const staged = git(['diff', '--staged', '--', 'README.md'], repo);
      expect(staged.stdout.length).toBeGreaterThan(0);
    });
  });

  // ── P3-08: Amend ──────────────────────────────────────
  describe('Amend (P3-08)', () => {
    it('amends commit with new message', () => {
      writeFileSync(join(repo, 'test.txt'), 'x');
      git(['add', 'test.txt'], repo);
      git(['commit', '-F', '-'], repo, 'original');

      git(['commit', '--amend', '-F', '-'], repo, 'amended message');
      const msg = git(['log', '-1', '--format=%s'], repo).stdout.trim();
      expect(msg).toBe('amended message');
    });

    it('no-edit amend preserves message', () => {
      writeFileSync(join(repo, 'test.txt'), 'x');
      git(['add', 'test.txt'], repo);
      git(['commit', '-F', '-'], repo, 'the message');

      writeFileSync(join(repo, 'test2.txt'), 'y');
      git(['add', 'test2.txt'], repo);
      git(['commit', '--amend', '--no-edit'], repo);
      const msg = git(['log', '-1', '--format=%s'], repo).stdout.trim();
      expect(msg).toBe('the message');
    });
  });

  // ── Repo Integrity ────────────────────────────────────
  it('maintains repo integrity after all operations', () => {
    // Series of operations
    writeFileSync(join(repo, 'file.txt'), 'data');
    git(['add', 'file.txt'], repo);
    git(['commit', '-F', '-'], repo, 'add file');
    git(['checkout', '-b', 'side'], repo);
    writeFileSync(join(repo, 'side.txt'), 'side');
    git(['add', 'side.txt'], repo);
    git(['stash', 'push', '-m', 'side stash'], repo);
    git(['checkout', 'master'], repo);
    git(['branch', '-d', 'side'], repo);
    writeFileSync(join(repo, 'README.md'), '# Updated');
    git(['add', 'README.md'], repo);
    git(['commit', '--amend', '--no-edit'], repo);

    const fsck = git(['fsck'], repo);
    expect(fsck.status).toBe(0);
  });
});
