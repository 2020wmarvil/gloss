# Gloss

**G**raphical **L**ayer **O**ver **S**hell **S**essions

*Goodbye, Long Off-topic Scrolling Sessions.*

A desktop GUI for coding agents (using [Agent Client Protocol](https://agentclientprotocol.com) later) that lets you reply to a single point in an agent's answer as its own thread, without scrolling past forty turns about item 1 to find item 2 again.

The agent still sees one linear conversation. Threads are just how Gloss shows it to you.

> A *gloss* is a note written in the margin of a manuscript, beside the exact line it explains.

## Status

**M2 (linear chat).** Sessions in a project folder, streamed markdown replies, tool-call rows, cancel, persistence across restarts with the agent resuming where it left off, and in-app sign-in. Threads come in M3. See [`docs/MILESTONES.md`](docs/MILESTONES.md).

Not yet: approving tool calls. Until M5, Gloss declines any tool call the agent asks permission for (reading and searching files usually doesn't need permission; editing files and running commands does) and says so in the conversation.

## Requirements

- Node.js 22 or newer and npm (for development only; the agent runs on Electron's bundled Node).
- A Claude account. If the agent isn't signed in, Gloss shows a **Sign in** dialog with the agent's own sign-in options and opens a terminal window to complete it. It uses the same login as the `claude` command, so if `claude` already works, you're set.

## Getting started

```bash
npm install
npm run dev
```

The first run downloads the Electron binary. Click **New session**, pick a project folder, and message the agent. Enter sends; Shift+Enter adds a new line.

### Dev model toggle

**Dev model (Haiku)**, at the bottom of the sidebar, runs the agent with `ANTHROPIC_MODEL=haiku` so test prompts are cheap. It is on by default in development and stored in `settings.json` in Electron's user-data folder. Changing it restarts idle agents; a running turn finishes on the old model. Judge the threading UX on the normal model; Haiku gives shorter, less list-heavy answers.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Run the app with hot reload |
| `npm run build` | Type-check, then build to `out/` |
| `npm start` | Run the built app from `out/` |
| `npm run typecheck` | Type-check main/preload and renderer |
| `npm run lint` | ESLint |
| `npm test` | Unit tests (Vitest), including a fake ACP agent |

## Layout

```
src/
  main/       Electron main process
    acp.ts        ACP connection to one agent process
    sessions.ts   Sessions, turns, resume, sign-in (SessionManager)
    db.ts         SQLite persistence (node:sqlite)
    agents.ts     Agent configurations
    terminal.ts   Runs terminal sign-in commands in a terminal window
  preload/    contextBridge API exposed to the renderer as window.gloss
  renderer/   React UI; talks to main only through window.gloss
  shared/     Types shared across processes (data model, IPC contract)
docs/
  SPEC.md         The design
  MILESTONES.md   Build order
  mocks/          HTML mockups (open in a browser)
```

Data lives in Electron's user-data folder (`%APPDATA%\Gloss` on Windows): `gloss.db` and `settings.json`.

## How it works

- **ACP.** The main process spawns [`@agentclientprotocol/claude-agent-acp`](https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp) with Electron's own Node runtime (`ELECTRON_RUN_AS_NODE`) and talks JSON-RPC over stdio using [`@agentclientprotocol/sdk`](https://www.npmjs.com/package/@agentclientprotocol/sdk). One agent process serves all sessions for that agent. Gloss advertises no `fs` or `terminal` client capabilities, so the agent uses its own tools.
- **Persistence.** The database is the display state. After a restart, a session reconnects on its next message using `session/load` when the agent supports it; otherwise Gloss starts a new agent session and says the agent lost context.
- **Sign-in.** Agent-agnostic: Gloss shows whatever `authMethods` the agent advertises when a request fails with ACP's `auth_required` error, runs the chosen one, and retries.
- **Security.** The renderer runs with `contextIsolation`, `sandbox` and no Node integration, under a strict Content Security Policy. Agent output is untrusted: markdown is rendered without raw HTML, only `http(s)` and `mailto` links are clickable (and open in the system browser), and images are never loaded.

## License

MIT
