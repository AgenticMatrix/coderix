import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { builtinModules } from 'node:module'

const STUB_PATH = resolve(__dirname, 'src/main/node-sqlite-stub.cjs')

// node:sqlite is a builtin in Node 22+ but NOT in Electron 33 (Node 20).
// undici's lazy require() gets hoisted to top-level by Rollup in CJS output.
// This plugin rewrites it to require the local stub so the bundle works in
// Electron's Node.js runtime without touching the module loader.
function sqliteStubPlugin(): Plugin {
  const STUB_RE = /require\(["']node:sqlite["']\)/g
  const STUB_ABS = JSON.stringify(STUB_PATH)
  return {
    name: 'sqlite-stub',
    generateBundle(_opts, bundle) {
      for (const [name, chunk] of Object.entries(bundle)) {
        if (chunk.type === 'chunk' && name.endsWith('.cjs')) {
          const code = chunk.code as string
          if (code.includes('node:sqlite')) {
            chunk.code = code.replace(STUB_RE, `require(${STUB_ABS})`)
          }
        }
      }
    },
  }
}

const external = [
  'electron',
  'electron/main',
  'node-pty',
  ...builtinModules.flatMap(m => m === 'sqlite' ? [] : [m, `node:${m}`]),
]

export default defineConfig({
  main: {
    plugins: [sqliteStubPlugin()],
    build: {
      outDir: 'dist/main',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
        },
        external,
        output: {
          format: 'cjs',
          // Guard: restart Electron if ELECTRON_RUN_AS_NODE is set,
          // otherwise Electron runs as plain Node.js and require('electron')
          // returns the npm package path instead of the Electron API.
          banner: `if(process.env.ELECTRON_RUN_AS_NODE){delete process.env.ELECTRON_RUN_AS_NODE;var c=require('child_process').spawnSync(process.execPath,process.argv.slice(1),{stdio:'inherit',env:process.env});process.exit(c.status!=null?c.status:1)}`,
        },
      },
    },
    resolve: {
      alias: {
        'node:sqlite': STUB_PATH,
      },
    },
  },
  preload: {
    build: {
      outDir: 'dist/preload',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
        },
        external,
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    css: {
      modules: {
        localsConvention: 'camelCaseOnly',
      },
    },
    build: {
      outDir: resolve(__dirname, 'dist/renderer'),
    },
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer'),
      },
    },
  },
})
