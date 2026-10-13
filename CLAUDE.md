# Gloss

**G**raphical **L**ayer **O**ver **S**hell **S**essions. Use "Gloss" / `gloss` as the product, package and window name.

Electron desktop app: a GUI for coding agents (via the Agent Client Protocol) with threaded replies to individual points in an agent's response.

## Read first
- `docs/SPEC.md` — the design. It is settled; follow it. If something in it seems wrong or unworkable, stop and ask rather than redesigning.
- `docs/MILESTONES.md` — build order.
- `docs/mocks/*.html` — open in a browser for the intended layout and interactions.

## How to work
- Do one milestone at a time. At the end of each, stop: summarize what works, how to run it, and anything that deviated from the spec. Wait for review.
- Build what the spec and the current milestone describe. Don't add features beyond them, even if they seem easy; propose them instead.
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

## Verified external APIs (M7)
- The Claude adapter advertises `sessionCapabilities` `list` and `delete`, `promptCapabilities` `image` and `embeddedContext`. `session/list` with an empty `cwd` lists every project's sessions, so never send one. `session/delete` removes Claude Code's transcript.
- Its model is the config option with `category: "model"`; `session/set_config_option` takes `{ sessionId, configId, value }`. The model chosen in a session persists in its transcript across `session/load`.
- It sends `available_commands_update` right after `session/new`, possibly before the response, so updates for an unknown ACP session id are buffered.
- Without the client `terminal` capability, a command's output arrives as `content` text in a console code block; edits arrive as `diff` content.
- `/mcp` is a prompt the adapter answers itself with a markdown list of server statuses. So is `/usage` (plan limits, cost).
- Plan limits: the adapter forwards Claude Code's `rate_limit_event` as `usage_update._meta["_claude/rateLimit"]` (SDKRateLimitInfo), only after the turn has token usage. A real event far from the limit has no `utilization`: `{"status":"allowed","resetsAt":<unix s>,"rateLimitType":"five_hour",...}`. The scale of `utilization` is undocumented; Gloss treats values up to 1 as a fraction.

## Verified external APIs (M8)
- Steering: the Claude adapter (0.89) advertises `_meta: { steering: { supported: true } }` at the top level of the `initialize` response and serves the extension request `_session/steering` `{ sessionId, prompt: ContentBlock[], _meta?: { steering: { idleBehavior: "promptRequired" } } }` → `{ outcome: "injected" | "promptRequired" | "startedNewTurn" }`. Without the `promptRequired` opt-in, steering an idle session starts a detached turn; Gloss always opts in.
- An injected message runs inside the pending `session/prompt`: its output streams as normal `session/update`s and that prompt's response comes once it is answered. The adapter doesn't echo it as a `user_message_chunk`.
- The SDK sends custom methods with `conn.agent.request(method, params)`; an in-process agent registers one with `.onRequest(method, { parse }, handler)` (a parser is required).

## Verified external APIs (M9)
- `plan` updates list the whole plan each time (`entries: { content, priority, status }[]`). The Claude adapter turns `TodoWrite` and the `Task*` tools into them (no `tool_call` for those).
- Claude Code only gives those tools to older models by default (a fixed list: Opus 4.x, Sonnet 4.0-4.6, Haiku 4.5, the 3.x line), in the CLI too. Newer models (Opus 5.5, current Haiku) have neither and never send a plan unless `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` (`CLAUDE_CODE_ENABLE_TASKS` alone doesn't help). Gloss sets it in the Claude agent config.

## Verified external APIs (PR badge)
- `gh` 2.74: `gh pr view --json number,title,state,isDraft,url,statusCheckRollup,reviewDecision` with no argument finds the current branch's PR, merged ones included (so Gloss compares `headRefOid` with `HEAD` for those). `state` is `OPEN`/`MERGED`/`CLOSED`; `reviewDecision` is `""` with none. `statusCheckRollup` mixes `CheckRun`s (`status`, `conclusion`) and `StatusContext`s (`state`).
- `git for-each-ref --format=%(upstream:remotename)%00%(upstream:remoteref) refs/heads/<b>` prints the upstream as `origin\0refs/heads/dev`.

## Git
- Work on `dev`; open one PR per milestone against `main`.

## Dev model
Run the agent with `ANTHROPIC_MODEL=haiku` during development via the `devModel` setting (Settings screen, or `settings.json` in the app's `userData` folder).
