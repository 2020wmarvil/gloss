# Gloss

**G**raphical **L**ayer **O**ver **S**hell **S**essions. Use "Gloss" / `gloss` as the product, package and window name.

Electron desktop app: a GUI for coding agents (via the Agent Client Protocol) with threaded replies to individual points in an agent's response.

## Read first
- `docs/SPEC.md` — the design. It is settled; follow it. If something in it seems wrong or unworkable, stop and ask rather than redesigning.
- `docs/MILESTONES.md` — build order.
- `docs/mocks/*.html` — open in a browser for the intended layout and interactions.

## How to work
- Do one milestone at a time. At the end of each, stop: summarize what works, how to run it, and anything that deviated from the spec. Wait for review.
- Respect the **Not part of the design** list in the spec. Don't add features from it, even if they seem easy.
- Verify external APIs before relying on them: the ACP TypeScript SDK (`@agentclientprotocol/sdk`) client API, the Claude Code ACP adapter's package name and entrypoint, and whether this Electron version's Node has `node:sqlite`. Check docs or source; don't guess.
- Keep agent/ACP/DB logic in the main process. The renderer talks to it only through the preload IPC API.
- Never relax the Electron security settings in the spec to make something work.

## Stack
- Electron + electron-vite, TypeScript (strict).
- SQLite (`node:sqlite` if available, else `better-sqlite3` + `electron-rebuild`).
- Developer is on Windows; keep scripts cross-platform (no bash-only npm scripts).

## Commands
- `npm run dev`: run with hot reload
- `npm run build`: typecheck + build to `out/`
- `npm run typecheck`, `npm run lint`, `npm test` (Vitest)

## Testing
- `src/main/sessions.test.ts` drives `SessionManager` against an in-process fake ACP agent (`acp.agent()` + `AgentConnection.open(agentApp, ...)`). Extend it for new agent-facing behavior.
- If you launch the app from inside a Claude Code session, unset the inherited `CLAUDE*`/`ANTHROPIC*` env vars first, or the agent uses the host session's auth.
- Point `CLAUDE_CONFIG_DIR` at an empty folder to test the signed-out path without touching the real login.

## Verified external APIs (M1)
- ACP SDK `@agentclientprotocol/sdk@1.8.0` is ESM-only; use `acp.client({...}).onNotification/onRequest(...).connect(ndJsonStream(...))`, then `conn.agent.request(methods.agent.*)`. It is bundled into the CJS main build (see `electron.vite.config.ts`).
- Claude adapter: `@agentclientprotocol/claude-agent-acp` (the `@zed-industries/*` packages are deprecated). Entrypoint `dist/index.js`, run with Electron's Node via `ELECTRON_RUN_AS_NODE=1`. It reads `ANTHROPIC_MODEL` and advertises `loadSession: true`.
- Electron 44 ships Node 24.21: `node:sqlite` works unflagged (SQLite 3.53), so no `better-sqlite3`.
- electron-vite 5 needs Vite 7 (so `@vitejs/plugin-react@5`). typescript-eslint needs TypeScript < 6.1, so TS is pinned to 5.9.
- Auth: ACP `auth_required` is JSON-RPC code `-32000`. With `clientCapabilities.auth.terminal: true`, the Claude adapter offers terminal methods ("Claude Subscription", "Anthropic Console") whose `args` are appended to the adapter's own command. `session/load` replays history as `session/update`s; ignore them.

## Git
- Work on `dev`; open one PR per milestone against `main`.

## Dev model
Run the agent with `ANTHROPIC_MODEL=haiku` during development via the app's dev toggle.
