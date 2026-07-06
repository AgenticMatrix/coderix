import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { builtinModules } from 'node:module'

// Everything gets bundled EXCEPT electron and Node.js builtins.
// This avoids CJS/ESM interop issues in Electron's Node.js runtime.
// node:sqlite is NOT a builtin in Electron 33 (Node 20), so we stub it.
const external = [
  'electron',
  'electron/main',
  ...builtinModules.filter(m => m !== 'sqlite'),
  ...builtinModules.filter(m => m !== 'sqlite').map(m => `node:${m}`),
]

export default defineConfig({
  main: {
    build: {
      outDir: 'dist/main',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
        },
        external,
        output: {
          format: 'cjs',
        },
      },
    },
    resolve: {
      alias: {
        // Electron 33 (Node 20) doesn't have node:sqlite — stub it
        'node:sqlite': resolve(__dirname, 'src/main/node-sqlite-stub.cjs'),
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
