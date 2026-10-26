// Build the real main-process session code, then run it in Electron's Node runtime.
import { build } from 'vite'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import process from 'node:process'

const require = createRequire(import.meta.url)
await build({
  configFile: false,
  logLevel: 'error',
  build: {
    target: 'node24',
    outDir: 'out/bench-new-session',
    emptyOutDir: false,
    lib: { entry: 'scripts/bench-new-session.ts', formats: ['cjs'], fileName: () => 'runner.cjs' },
    rollupOptions: { external: (id) => id.startsWith('node:') || id === 'smol-toml' }
  }
})
const child = spawn(require('electron'), [resolve('out/bench-new-session/runner.cjs'), ...process.argv.slice(2)], {
  stdio: 'inherit', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
})
child.on('error', (error) => { throw error })
child.on('exit', (code) => { process.exitCode = code ?? 1 })
