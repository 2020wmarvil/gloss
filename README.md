# Gloss

**G**raphical **L**ayer **O**ver **S**hell **S**essions

*Goodbye, Long Off-topic Scrolling Sessions.*

A desktop GUI for coding agents (Claude Code first, anything that speaks the [Agent Client Protocol](https://agentclientprotocol.com) later) that lets you reply to a single point in an agent's answer as its own thread, without scrolling past forty turns about item 1 to find item 2 again.

The agent still sees one linear conversation. Threads are just how Gloss shows it to you.

> A *gloss* is a note written in the margin of a manuscript, beside the exact line it explains.

## Status

**M1 (ACP spike).** The app spawns Claude Code through its ACP adapter, opens a session, sends one hard-coded prompt and streams the reply to a bare page. See [`docs/MILESTONES.md`](docs/MILESTONES.md) for what comes next.

## Requirements

- Node.js 22 or newer and npm (for development only; the agent runs on Electron's bundled Node).
- A signed-in Claude Code account. Gloss runs the Claude CLI bundled with the adapter, which uses the same login as your `claude` command. Check it with `claude auth status`; sign in with `claude auth login` (or run `claude` and use `/login`). Setting `ANTHROPIC_API_KEY` in the environment also works.

## Getting started

```bash
npm install
npm run dev
```

The first run downloads the Electron binary. In the window, click **Run spike prompt**. The agent's reply streams into the page, and every ACP `session/update` is also logged to the terminal running `npm run dev`.

### Dev model toggle

The **Dev model (Haiku)** checkbox spawns the agent with `ANTHROPIC_MODEL=haiku` so test prompts are cheap. It is on by default in development and is stored in `settings.json` in Electron's user-data folder. It applies to the next agent process. Judge the threading UX on the normal model; Haiku gives shorter, less list-heavy answers.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Run the app with hot reload |
| `npm run build` | Type-check, then build to `out/` |
| `npm start` | Run the built app from `out/` |
| `npm run typecheck` | Type-check main/preload and renderer |
| `npm run lint` | ESLint |
| `npm test` | Unit tests (Vitest) |

## Layout

```
src/
  main/       Electron main process: agent spawning, ACP connection, settings (later: SQLite)
  preload/    contextBridge API exposed to the renderer as window.gloss
  renderer/   React UI; talks to main only through window.gloss
  shared/     Types shared across processes (IPC contract)
docs/
  SPEC.md         The design
  MILESTONES.md   Build order
  mocks/          HTML mockups (open in a browser)
```

## How it works

- **ACP.** The main process spawns [`@agentclientprotocol/claude-agent-acp`](https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp) with Electron's own Node runtime (`ELECTRON_RUN_AS_NODE`) and talks JSON-RPC over stdio using [`@agentclientprotocol/sdk`](https://www.npmjs.com/package/@agentclientprotocol/sdk). Gloss advertises no `fs` or `terminal` client capabilities, so the agent uses its own tools.
- **Security.** The renderer runs with `contextIsolation`, `sandbox` and no Node integration, under a strict Content Security Policy. Agent output is treated as untrusted: new windows are blocked and web links open in the system browser.

## License

MIT
