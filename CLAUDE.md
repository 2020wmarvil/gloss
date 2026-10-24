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
- `npm run icons`: regenerate the app icon files in `build/` from `build/icon.svg` and `build/icon-small.svg`

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

## Verified external APIs (shared sessions)
- The Claude adapter (0.89) advertises `sessionCapabilities.close`; SDK 1.8.0 has `methods.agent.session.close`. A `session/load` of a session the adapter already holds re-reads the transcript and replays it, but keeps the running Claude process when the params are unchanged, so the model doesn't see turns added elsewhere. `session/close` then `session/load` starts a fresh process that does (tested with `claude -p --resume` turns in between).
- `messageId` is stable between live and replay: agent messages use the API message id, user messages the transcript entry's uuid. Replay chunks carry no timestamps or `_meta`.
- An embedded text `resource` replays as text chunks of the user message: `[@name](uri)`, then `\n<context ref="uri">\n…\n</context>`.
- After `/compact`, the replay starts at Claude Code's summary, a user message beginning "This session is being continued from a previous conversation"; nothing before it is replayed.
- A cancelled turn replays with its partial answer (more text than was streamed before the cancel) and then a user message `[Request interrupted by user]`. A steered message replays as a user message where it was injected, between the two parts of the answer.
- `session/list` `updatedAt` doesn't move after a turn ends (checked 12 s later), but `session/load` changes it. Listing takes about 20 ms; `session/close` + `session/load` about 0.6 s.
- Electron honors `--user-data-dir=<folder>` for `app.getPath('userData')`. Pass it in dev with `npm run dev -- -- --user-data-dir=<folder>` (electron-vite forwards what follows its own `--`). `npm run dev` also writes `out/main` and `out/preload`, which a running built Gloss loads on restart.
- A shell inside a Gloss session inherits `ELECTRON_RUN_AS_NODE=1` (set for the adapter): unset it to launch Electron from there.

## Verified external APIs (usage popup)

- `@anthropic-ai/claude-agent-sdk@0.3.293` exposes `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })`. It works on a query whose async prompt input never yields, with `persistSession: false`, including when session usage is 100%. Close and abort the query after the request. Verified through Electron and the built app's preload/IPC path; a scratch project acquired no transcript and the app recorded no messages.
- Utilization from this request is already a percentage (100 means exhausted), unlike the adapter's rate-limit events. Context must still come from the real session's ACP updates. The SDK is a pinned direct dependency because this method is experimental.

## Git
- Work on `dev`; open one PR per milestone against `main`.

## Dev model
There is no dev model setting. When testing against a live agent, pick Haiku yourself: set `ANTHROPIC_MODEL=haiku` in the environment Gloss (and so the agent) is launched with, or set the session's model option.

## Verified external APIs (Codex support)

- `@agentclientprotocol/codex-acp@2.2.2` runs from `dist/index.js` under Electron with `ELECTRON_RUN_AS_NODE=1`. It launches its bundled `@openai/codex` CLI using the same runtime; Windows x64 was tested.
- It advertises load/list/close/delete, images, embedded context, and the same steering extension Gloss already uses. Bypass mode is `agent-full-access`; model selection uses the `model` config option. The Claude dev override must not disable Codex's model picker.
- With an empty `CODEX_HOME`, `session/new` returns ACP `auth_required`; the advertised `chat-gpt` method handles browser sign-in via `authenticate` (Codex's `account/login/start`, callback on `127.0.0.1:1455`), and writes `auth.json` there. Existing Codex login works without another sign-in. A fresh browser login was completed through the built app.
- On Windows, `@openai/codex/bin/codex.js` spawns the native `codex.exe` without `windowsHide`. Its parent (Electron as Node) has no console, so each launch opened a visible terminal window. `patches/@openai+codex+*.patch` (applied by `patch-package` on `postinstall`) adds the flag; regenerate it with `npx patch-package @openai/codex` when bumping the adapter.
- Verified live through Electron and SessionManager: streaming, thread routing, model selection with Haiku enabled, tool execution, and thread preservation after restart/resume.
- A stdio MCP server from Gloss's global list shows up as `mcp__<name>__<tool>` in Claude and `mcp.<name>.<tool>` in Codex; both called it live.

## Verified external APIs (agent instructions)
- Claude adapter (0.89): `_meta.systemPrompt` on `session/new`/`session/load` (a string replaces the preset; `{ append }` appends to it). Claude Code snapshots the system prompt when a session is created: a resume through the Agent SDK (0.3.293) keeps the creation-time one and ignores a new append (the CLI's `--resume --append-system-prompt` does apply it). `systemPrompt` is part of the adapter's session fingerprint, so a load with different `_meta.systemPrompt` restarts a held session.
- Codex adapter (2.2.2): only `_meta.jetbrains.air.customInstructions` on `session/new` (→ `developerInstructions`); `session/load` ignores it. Request `_meta` doesn't make it treat the client as AIR (that comes from `initialize`).

## Verified external APIs (effort)
- Both adapters report effort as a select config option with `category: "thought_level"`, set with `session/set_config_option` like the model. Claude (0.89): id `effort`, name "Effort", levels from the model's `supportedEffortLevels` plus "Default"; no option at all for a model without effort. Codex (2.2.2): id `reasoning_effort`, name "Reasoning effort".
- The Claude adapter rebuilds its config options on a model switch (effort levels depend on the model), so re-apply the effort after the model.
- Claude's `default` effort means "Claude Code decides"; the level it resolves (`applied.effort`) isn't sent over ACP and the SDK only reports it on Remote Control init frames. The adapter turns `default` into a concrete level (`medium`, else the first) only for clients advertising `_meta.jetbrains.air` with `recommendedValue`, but any `_meta.jetbrains.air` makes it treat the client as JetBrains AIR (deduplicated updates, different plans, tool-call `_meta` and elicitation), so Gloss sets the concrete level itself instead.

## Verified external APIs (global MCP import)

- Claude native MCP entries live in `~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`), both at the top level and under `projects[path].mcpServers`; project-shared entries live in `.mcp.json`. Codex uses `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`) and project `.codex/config.toml` files. Import previews copy selected entries into Gloss's global list and never write agent files.
- Codex `env_vars` is an allow list, so missing variables are omitted. HTTP `env_http_headers` and `bearer_token_env_var` resolve from Gloss's environment at import time. OAuth state, tool restrictions, working directories and helper commands cannot be faithfully expressed through ACP and are not silently transferred.
- codex-acp 2.2.2 normally filters requested servers whose names already appear in native Codex config. `DISABLE_MCP_CONFIG_FILTERING=true` disables that filter, so explicit Gloss entries can override native entries and later edits take effect. Confirmed in the installed adapter's `shouldDeduplicateMcpConflicts` and `createSessionConfig` source.

## Verified external APIs (review sessions)
- `git diff <merge base>` compares the working tree (staged and unstaged) with the base; untracked files need `git ls-files --others --exclude-standard -z --full-name :/`, which gives repository-root paths like the diff, from any subfolder. With `core.autocrlf=true` (this machine) diff lines can end in `\r`; the parser strips it.
- `git symbolic-ref --short refs/remotes/origin/HEAD` prints `origin/main`, and fails without a remote HEAD.
- Live, Haiku 5.5 (through the Claude adapter) followed the first-pass format: a summary, then a valid `gloss-findings` block with correct line numbers, and fixed a finding in its thread when asked, which marked it outdated.
- When driving the built app over CDP from Git Bash, pass paths with forward slashes: backslashes in `node -e`/argv strings get eaten by the shell.
- Draft reviews: the Claude adapter's `session/new` (0.89) starts a `claude.exe` (about 235 MB) in about 0.4 s, writes no transcript and isn't returned by `session/list` until the first prompt; `session/close` stops that process at once, so an unused session needs no `session/delete`.

## Verified external APIs (editor focus)
- On Windows a running editor handed a file (`code -g`, through `cmd.exe`) stays behind Gloss: Windows' foreground lock refuses it while the user is using Gloss. Gloss, in front, calls `AllowSetForegroundWindow(ASFW_ANY)` before launching it (`src/main/foreground.ts`), through `koffi@3.3.3` (MIT, N-API, so no `electron-rebuild`). Checked with real input (a `keybd_event` keystroke; CDP input doesn't count): without the call VS Code stayed behind in 4 of 4 runs, with it it came forward in 6 of 7 and in the built app.
- koffi's binaries come from `@koromix/koffi-<platform>` optional dependencies (`win32_x64/koffi.node`); its `install` script (`cnoke --prebuild`) isn't needed and npm leaves it unapproved. It stays external to the main bundle, loaded with `await import('koffi')` only on Windows.

## Verified external APIs (M15)
- SDK 1.8.0: `elicitation/create` is `methods.client.elicitation.create`; params are `{ mode: 'form', sessionId, toolCallId?, message, requestedSchema }` (or `mode: 'url'` with `url`, `elicitationId`), the answer `{ action: 'accept', content } | { action: 'decline' } | { action: 'cancel' }`. Client handlers get `ctx.signal`, which aborts on the agent's `$/cancel_request`; the client must still answer. An in-process agent sends one with `ctx.client.request(method, params, { cancellationSignal })`.
- Claude adapter (0.89): with `clientCapabilities.elicitation.form` it enables AskUserQuestion (otherwise it's in `disallowedTools`) and sends one form per call: `question_<n>` (`oneOf` for single, `array` + `items.anyOf` for multi-select, header as `title`, question text as `description` when there are several) plus an optional `question_<n>_custom` "Other" text field; nothing is required. `decline` gives the model empty answers (skipped), `cancel` aborts the tool call. Live on Haiku 5.5 the question arrived even in `bypassPermissions` mode.
- Its modes: `default` "Manual", `acceptEdits`, `plan`, `auto`, `bypassPermissions` (bypass dropped when running as root). `session/set_mode` doesn't echo `current_mode_update`; the adapter sends one only when it changes the mode itself (plan approval, Auto fallback). A load resumes in the transcript's last mode.
- In Manual, an edit's `session/request_permission` carries the tool call's title ("Write no.txt"), `kind: 'edit'`, a `diff` content and the options `allow-once` "Yes" (allow_once), `allow-with-updates` "Yes, allow all edits during this session" (allow_always), `reject` "No" (reject_once). Rejecting fails the tool call and the model carries on; the adapter emits the tool call before the request.
- Launching the built app from a shell inside a Gloss dev session also inherits `ELECTRON_RENDERER_URL`: unset it (with `ELECTRON_RUN_AS_NODE`), or the window loads the dev server instead of `out/renderer`.

## Verified external APIs (M16)
- Claude adapter (0.89): a prompt of `[text, image, text]` replays (`session/load`) as three `user_message_chunk`s in order under one `messageId`; Gloss's replay parser joins text chunks, so a screenshot's pin list goes in the message's own text block (before the images) to keep `wireText` matching the replay.
- `desktopCapturer.getSources({ types: ['screen'], thumbnailSize })` in the main process (Electron 44) gives a `NativeImage` at the requested physical size; match the display with `source.display_id === String(display.id)`. `screen.dipToScreenRect(null, display.bounds)` (Windows only) gives the display's physical rectangle, which window frames are in.
- Window frames on Windows through koffi: `GetTopWindow(null)` then `GetWindow(h, GW_HWNDNEXT)` walks top-level windows in z-order (koffi needs the explicit `null` argument), `DwmGetWindowAttribute` `DWMWA_EXTENDED_FRAME_BOUNDS` (9) into a `_Out_` struct gives the visible frame, `DWMWA_CLOAKED` (14) into a `_Out_ uint32_t*` (pass `[0]`) skips cloaked windows. Electron is per-monitor DPI aware, so the frames are physical pixels.
- Sandboxed preloads must each be one file: the overlay's preload (`src/preload/capture.ts`) and the main one share no module (the main window's `capture.start` channel is in `IPC`), so Rollup makes no shared chunk. electron-vite builds both pages and preloads from `rollupOptions.input`.
- `desktopCapturer.getSources` scales every screen's thumbnail to the one `thumbnailSize`, so displays of different sizes need a call each. Two 2560×1440 displays at 100% (x −2560 and 0) gave one overlay each with exact bounds.
- Windows' foreground lock refuses `BrowserWindow.focus()` to an overlay opened by `globalShortcut` while another app is in front, so its keys go to that app. `AttachThreadInput` to the foreground window's thread around `SetForegroundWindow` (koffi, `takeForeground` in `src/main/foreground.ts`) brings it forward; checked with real `keybd_event` keys (Ctrl+Shift+PrtSc, then Esc) while another process's window was in front.
- A `globalShortcut` takes its keys before any window sees them, Gloss's own included, so the settings screen's shortcut recorder pauses it (`capture.pauseShortcut`) while recording. Windows sends no `keydown` for PrintScreen, only `keyup`.
- CDP's `Page.captureScreenshot` hangs on the overlay window; read its canvases with `Runtime.evaluate` instead. To test the canvas without the overlay covering the screen, replace the `gloss:capture:start` handler from the main-process inspector (`--inspect`).

## Verified external APIs (HDR capture)
- With Windows HDR on, `desktopCapturer` (Electron 44) returns the display as 8-bit without tone mapping: SDR content comes out clipped and washed out. Electron's `Display.colorSpace` still reports sRGB for it, so detect HDR through DXGI: `IDXGIOutput6::GetDesc1` `ColorSpace` 12 (`RGB_FULL_G2084_NONE_P2020`).
- `IDXGIOutput5::DuplicateOutput1` with `R16G16B16A16_FLOAT` (device from `D3D11CreateDevice` on the output's own adapter) gives scRGB (linear, 1.0 = 80 nits); the first `AcquireNextFrame` returns the whole desktop in about 10 ms. Dividing by the SDR white level (`DisplayConfigGetDeviceInfo` type 11, thousandths of 80 nits, matched by the source's GDI name) gives the image as SDR content is shown. Vtable slots in `src/main/hdr.ts` are from the 10.0.26100 SDK headers.
- `koffi.view` crashes Electron (no external ArrayBuffers); copy native memory into a Buffer with `RtlMoveMemory`.
- The capture overlay shares Chromium's per-host zoom with the main window when both load from the dev server (`localhost`), so CSS pixels there aren't the display's DIPs; the built app's `file://` pages don't share it.
