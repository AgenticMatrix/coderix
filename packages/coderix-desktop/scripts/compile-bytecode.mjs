// Compiles the Electron main-process bundle(s) to V8 bytecode (.jsc) via bytenode.
//
// Why: the main bundle holds the entire engine (QueryEngine, tools, core,
// claude-code-engine). Compiling it to bytecode removes the plain-text JS so the
// shipped app has no readable source. The renderer is handled separately by
// obfuscate-renderer.mjs.
//
// Strategy:
//   - compile every dist/main/**/*.cjs (index.cjs + code-split chunks) as a
//     CommonJS module to a sibling .jsc, using bytenode's `electronMain` mode
//     (compiles inside a real Electron main process so the V8 read-only-snapshot
//     checksum matches the process that will later load it).
//   - delete the .cjs sources,
//   - write a tiny loader dist/main/index.cjs that registers bytenode, redirects
//     the bundle's internal `require("./chunks/*.cjs")` to `.jsc`, then requires
//     ./index.jsc.

import { createRequire } from 'node:module'
import { readdirSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { join, dirname, relative, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const bytenode = require('bytenode')

const __dirname = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = join(__dirname, '..')
const MAIN_DIR = join(DESKTOP_DIR, 'dist', 'main')

const electronPath = require('electron')
if (!electronPath) {
  console.error('[bytecode] cannot resolve electron binary (require("electron"))')
  process.exit(1)
}

function collectCjsFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) {
      out.push(...collectCjsFiles(p))
    } else if (entry.endsWith('.cjs')) {
      out.push(p)
    }
  }
  return out
}

const LOADER = `// Generated loader — do not edit. Loads the V8-bytecode main bundle.
// Registers the .jsc loader, then routes the bundle's internal
// require("./chunks/*.cjs") to the compiled .jsc siblings.
require('bytenode');

const Module = require('module');
const _resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (typeof request === 'string' && request.endsWith('.cjs')) {
    try {
      return _resolveFilename.call(this, request.slice(0, -4) + '.jsc', parent, isMain, options);
    } catch (_) {
      // .jsc sibling does not exist — fall through to the original resolution.
    }
  }
  return _resolveFilename.call(this, request, parent, isMain, options);
};

module.exports = require('./index.jsc');
`

async function main() {
  const cjsFiles = collectCjsFiles(MAIN_DIR)
  if (cjsFiles.length === 0) {
    console.error('[bytecode] no .cjs files found under', MAIN_DIR)
    process.exit(1)
  }

  console.log(`[bytecode] compiling ${cjsFiles.length} bundle(s) with Electron main process (V8 ${process.versions.v8})`)

  for (const file of cjsFiles) {
    const rel = relative(MAIN_DIR, file)
    console.log(`[bytecode]   ${rel}`)
    await bytenode.compileFile({
      filename: file,
      compileAsModule: true,
      electronMain: true,
      electronPath,
    })
    // compileFile writes <file-without-ext>.jsc next to the source.
    const jsc = file.slice(0, -extname(file).length) + '.jsc'
    if (!statSync(jsc, { throwIfNoEntry: false })) {
      console.error(`[bytecode] failed to produce ${relative(MAIN_DIR, jsc)}`)
      process.exit(1)
    }
  }

  // Remove plain-text sources, then drop in the loader entry point.
  for (const file of cjsFiles) rmSync(file)
  writeFileSync(join(MAIN_DIR, 'index.cjs'), LOADER, 'utf-8')

  console.log('[bytecode] done — dist/main now contains only .jsc + loader index.cjs')
}

main().catch((err) => {
  console.error('[bytecode] error:', err)
  process.exit(1)
})
