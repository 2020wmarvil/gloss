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
  preload: {},
  renderer: {
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    },
    plugins: [react()]
  }
})
