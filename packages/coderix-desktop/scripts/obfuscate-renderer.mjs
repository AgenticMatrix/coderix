// Obfuscates the built renderer JS bundle(s) so the shipped UI source is not
// trivially readable. Uses javascript-obfuscator with conservative settings that
// are safe for React/bundled apps (no control-flow flattening, self-defending,
// dead-code injection, or transformObjectKeys — those tend to break large bundles
// and blow up startup time).
//
// The entry file is referenced by dist/renderer/index.html by its hashed name
// (e.g. ./assets/index-<hash>.js); we rewrite the file in place, so the reference
// stays valid.

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import JavaScriptObfuscator from 'javascript-obfuscator'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ASSETS_DIR = join(__dirname, '..', 'dist', 'renderer', 'assets')

const OPTIONS = {
  compact: true,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  debugProtection: false,
  disableConsoleOutput: false,
  identifierNamesGenerator: 'hexadecimal',
  numbersToExpressions: true,
  renameGlobals: false,
  selfDefending: false,
  simplify: true,
  splitStrings: true,
  splitStringsChunkLength: 10,
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.75,
  transformObjectKeys: false,
  unicodeEscapeSequence: false,
  target: 'browser',
  sourceMap: false,
}

function collectJsFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) out.push(...collectJsFiles(p))
    else if (entry.endsWith('.js')) out.push(p)
  }
  return out
}

function main() {
  const files = collectJsFiles(ASSETS_DIR)
  if (files.length === 0) {
    console.error('[obfuscate] no .js files found under', ASSETS_DIR)
    process.exit(1)
  }

  for (const file of files) {
    const size = statSync(file).size
    console.log(`[obfuscate] ${basename(file)} (${(size / 1024 / 1024).toFixed(2)} MB)`)
    const src = readFileSync(file, 'utf-8')
    const result = JavaScriptObfuscator.obfuscate(src, OPTIONS)
    writeFileSync(file, result.getObfuscatedCode(), 'utf-8')
  }

  console.log('[obfuscate] done')
}

main()
