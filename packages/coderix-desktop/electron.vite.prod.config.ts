import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { builtinModules } from 'node:module'

const external = [
  'electron',
  ...builtinModules,
  ...builtinModules.map(m => `node:${m}`),
  'undici',
  /^undici\//,
]

export default defineConfig({
  main: {
    build: {
      outDir: 'dist/main',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
        external,
        output: { format: 'cjs' },
      },
    },
  },
  preload: {
    build: {
      outDir: 'dist/preload',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        external,
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    build: { outDir: resolve(__dirname, 'dist/renderer') },
  },
})
