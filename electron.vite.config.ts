import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      // The ACP SDK is ESM-only; bundle it into the CJS main build. The adapter
      // stays external: it runs as its own process from node_modules.
      externalizeDeps: { exclude: ['@agentclientprotocol/sdk'] }
    }
  },
  // The region overlay (SPEC → Visual feedback) is its own page with its own preload.
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts'), capture: resolve('src/preload/capture.ts') }
      }
    }
  },
  renderer: {
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html'), capture: resolve('src/renderer/capture.html') }
      }
    },
    plugins: [react()]
  }
})
