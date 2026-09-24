import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Nothing reachable from the mounted app may write to the terminal itself.
 *
 * Ink repaints in place: it rewinds the cursor up over the frame it believes it
 * drew, then overwrites it. That rewind is computed from ink's own record of
 * what it emitted, so a write from anywhere else moves the cursor without ink
 * knowing and the rewind lands mid-frame. The old frame is never erased, the
 * new one lands below it, and since such writes recur the stale copies stack
 * into a ladder — the same tool block repeated, each rung more complete than
 * the last, with a differently-valued status bar at every rung.
 * `foreign-write-strands-frames.test.tsx` in `@coderix/tui` demonstrates that
 * mechanism against real ink; this test stops it being reintroduced.
 *
 * `patchConsole: true` is not a defence. `patch-console` swaps the `console.*`
 * methods only and never touches `process.stdout/stderr.write`, so
 * `console.error` is replayed safely above the frame while a direct stream
 * write is not intercepted at all.
 *
 * Asserted over the real import graph rather than a directory, because the
 * offending write does not have to live in `tui/`: the one that caused the
 * reported symptom sat in a reducer, and an MCP subprocess spawned with
 * `stderr: 'inherit'` does the same damage from another process entirely.
 * Anything the mounted tree can pull in can corrupt the frame.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES = resolve(HERE, '../../../../..');

/** The mounted tree's root — what `main.tsx` hands to `renderSync`. */
const ENTRY = resolve(HERE, '../App.tsx');

/** Workspace packages, mapped to the source entry their `exports` resolve to. */
const WORKSPACE: Record<string, string> = {
  '@coderix/core': join(PACKAGES, 'coderix-core/src/index.ts'),
  '@coderix/tui': join(PACKAGES, 'coderix-tui/src/index.ts'),
};

/**
 * Files that write to a stream on purpose, each because it is the entry point
 * of a SEPARATE process that does not share the TUI's terminal. They appear in
 * the graph only because the package's barrel re-exports their factories; the
 * writing functions are never called in-process.
 */
const SEPARATE_PROCESS_ENTRY_POINTS = [
  'coderix-core/src/mcp/builtin/chrome-mcp/mcp-server.ts',
  'coderix-core/src/mcp/builtin/computer-use-mcp/mcp-server.ts',
];

const DIRECT_WRITE = /process\s*\.\s*(?:stdout|stderr)\s*\.\s*write/;
/** Handing a child our raw stderr is the same defect one process removed. */
const INHERITED_CHILD_STDERR = /stderr\s*:\s*['"]inherit['"]/;

/**
 * Strip comments before scanning. The rule constrains what the code DOES, and
 * the files fixed here carry comments naming the very construct they avoid —
 * scanning prose would flag the explanation as the offence.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
}

function resolveModule(spec: string, importer: string): string | null {
  let base: string;
  if (spec.startsWith('.')) base = resolve(dirname(importer), spec);
  else if (WORKSPACE[spec]) return WORKSPACE[spec]!;
  else return null; // node_modules and builtins are out of scope

  const candidates = [
    base,
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.js$/, '.tsx'),
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Every first-party module the mounted tree can reach, statically or lazily. */
function reachableFrom(entry: string): Map<string, string> {
  const sources = new Map<string, string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (sources.has(file)) continue;
    const source = readFileSync(file, 'utf8');
    sources.set(file, source);
    // Static `from '…'` and dynamic `import('…')` alike: the app defers most of
    // its wiring behind `await import`, so ignoring those would miss almost
    // everything.
    for (const match of source.matchAll(/(?:from\s*|import\s*\(\s*)['"]([^'"]+)['"]/g)) {
      const next = resolveModule(match[1]!, file);
      if (next) queue.push(next);
    }
  }
  return sources;
}

const GRAPH = reachableFrom(ENTRY);

const relative = (file: string) => file.slice(PACKAGES.length + 1);

function offenders(pattern: RegExp): string[] {
  const found: string[] = [];
  for (const [file, source] of GRAPH) {
    const name = relative(file);
    if (SEPARATE_PROCESS_ENTRY_POINTS.includes(name)) continue;
    if (name.includes('__tests__')) continue;
    if (pattern.test(code(source))) found.push(name);
  }
  return found.sort();
}

describe('everything the mounted app can reach', () => {
  it('walks a graph that actually contains the app', () => {
    // Without this, a resolver regression would empty the graph and every
    // assertion below would pass by looking at nothing.
    expect(GRAPH.size).toBeGreaterThan(100);
    const names = [...GRAPH.keys()].map(relative);
    expect(names).toContain('coderix-cli/src/tui/hooks/useChatReducer.ts');
    expect(names).toContain('coderix-core/src/core/session-store.ts');
  });

  it('never writes to process.stdout or process.stderr', () => {
    expect(
      offenders(DIRECT_WRITE),
      'route diagnostics through console.* — ink patches it and replays it above the frame',
    ).toEqual([]);
  });

  it('never gives a child process the terminal it does not own', () => {
    expect(
      offenders(INHERITED_CHILD_STDERR),
      "spawn with stderr: 'pipe' and forward the stream through console.*",
    ).toEqual([]);
  });

  it('still flags a write if one is reintroduced', () => {
    // The guard's own smoke test: the patterns must match the shape of the
    // write that caused the reported failure, not merely be absent today.
    const reintroduced = `process.stderr.write(\`[pricing] turnCost=\${cost}\\n\`);`;
    expect(DIRECT_WRITE.test(code(reintroduced))).toBe(true);
    expect(INHERITED_CHILD_STDERR.test(code(`{ command, stderr: 'inherit' }`))).toBe(true);
    // And comment-stripping must not blind it: only prose is exempt.
    expect(code('// process.stderr.write("x")')).not.toMatch(DIRECT_WRITE);
    expect(code('const x = 1; // note\nprocess.stdout.write("y");')).toMatch(DIRECT_WRITE);
  });
});
