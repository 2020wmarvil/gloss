# Gloss — Spec

**Gloss** = **G**raphical **L**ayer **O**ver **S**hell **S**essions
(also: **G**oodbye, **L**ong **O**ff-topic **S**crolling **S**essions)

A *gloss* is a medieval annotation written in the margin beside the specific line it explains — which is what a thread here is.

A desktop GUI for coding agents whose main feature is **threaded replies to individual points** in an agent's response. When the agent returns a multi-point answer (a numbered list of findings, ideas, issues), the user can open a thread on any point, discuss it in a side panel, and come back to the main conversation without scrolling past dozens of turns.

## Core idea: threading is view-only

The agent sees **one linear session**. Threads exist only in the UI.

- Each message is tagged with a `threadId` (`null` = main thread). The UI groups messages by it.
- A message sent from a thread is prefixed with a short tag quoting the anchor, so the agent knows what it refers to. This automates what the user does today by copy-pasting the bullet point.
- The agent's reply is routed to the thread the last prompt came from. Turns are sequential (a message sent during a turn waits in a queue until it ends, or steers the turn from the thread it runs in), so routing is unambiguous.

Consequences, all intended:
- No forking, no merging, no summaries. The agent has everything that happened in every thread in its context.
- One working tree. Edits made from any thread are visible everywhere.
- Works with any agent, because the agent session is not modified.
- The session stays the agent's own: it can be continued in the agent's CLI and back in Gloss (see Shared sessions).

## Anchors (what a thread hangs off)

Anchors live on **agent messages**. Two kinds:

1. **List item** (one click). Every top-level list item in a rendered agent message gets a reply affordance: a Reply button in the item's left margin on hover, and once a thread exists, a reply-count chip after the item's last line. The list stays a list.
2. **Text selection** (fallback). Any text selected in an agent message (prose, code, a list item) can be replied to: right-clicking the selection opens a menu with **Reply to selection** (`R`) and **Copy**, and `R` replies to it directly. Selecting doesn't show anything by itself. Right-clicking text outside the selection selects its (wrapped) line first, and dragging with the right button held selects every line passed over, within that message; releasing opens the menu. The selected span becomes the anchor.

Review sessions add a third kind, on the diff rather than a message: **diff lines** (see Review sessions).

Anchor positions are stored as offsets into the **source markdown**, not the DOM. Use the markdown renderer's source-position info (e.g. mdast `position` in remark/unified, or `map` in markdown-it) to map the DOM selection back to source offsets. Also store the anchor's text so it can be re-found if offsets drift.

## Wire format

User message in a thread is sent to the agent as:

```
[re: "<anchor text, truncated to ~80 chars>"]
<user's text>
```

Main-thread messages are sent unchanged, except the first one after a thread: when the user's previous message in the session was in a thread, the main message is sent as

```
[re: the main conversation, not the thread above]
<user's text>
```

so the agent doesn't read it as continuing that thread. It takes the thread tag's `[re: …]` form and avoids the bare word "main", which in a coding session reads as the git branch. The UI shows the user's text without the tag; the tag is stored in `wireText`.

A message sent to the main conversation from a thread (see Composer → Send to main) is a main-thread message sent as

```
[re: "<anchor text, truncated to ~80 chars>", continued in the main conversation]
<user's text>
```

so the agent knows which point it answers and that the discussion moves back to the main conversation. Being in the main thread, it ends the thread: the next main message is sent unchanged.

A thread on diff lines in a review session quotes the file and lines instead, with `(old)` for lines on the removed side and a range as `93-95`:

```
[re: src/main/git.ts:93 "<selected text, truncated to ~80 chars>"]
[re: src/main/git.ts:120-124 (old) "<selected text, truncated to ~80 chars>"]
```

### Agent instructions

Every session gives the agent this text, so it reads the tags as Gloss means them (`AGENT_INSTRUCTIONS` in `src/shared/wire.ts`):

> This session runs in Gloss, a GUI that lets the user reply to individual points of your answers in side threads. You see one conversation; the threads exist only in the UI.
>
> - Every message sent from a thread starts with `[re: "<quote>"]`, quoting the point it's about. Answer about that point and don't bring in other topics, open questions or follow-ups from elsewhere in the conversation; the user raises those in the main conversation.
> - `[re: "<quote>", continued in the main conversation]` replies to that point but moves the discussion back to the main conversation, so answer it in the broader context.
> - Messages in the main conversation are untagged, except the first one after a thread, which starts with `[re: the main conversation, not the thread above]`.

It is not a message: it goes in each agent's own channel for client instructions, so the transcript and the CLI don't show it. Claude Code: `_meta.systemPrompt.append` on `session/new`, appended to its system prompt. Codex: `_meta.jetbrains.air.customInstructions` on `session/new`, which becomes the thread's developer instructions. Both agents keep what a session was created with: a resume doesn't change it, so sessions created before Gloss sent these instructions go on without them. Gloss sends Claude's on `session/load` too, only so the adapter doesn't take the load for a changed session and restart it.

## Data model

```ts
type Session = {
  id: string
  agentId: string            // which agent config, e.g. 'claude' or 'codex'
  acpSessionId: string       // the ACP session id
  cwd: string                // its project (folder)
  title: string              // renamed in Gloss (titleSet), else the agent's title (session/list), else the first message or folder name
  titleSet?: true            // renamed in Gloss: the agent's title doesn't replace it
  createdAt: number
  model?: string             // model config value picked in Gloss; re-applied on resume
  effort?: string            // effort (thought_level) config value picked in Gloss; re-applied after the model
  syncedAt?: string          // the agent's updatedAt for this session when Gloss last synced it (see Shared sessions)
  review?: { baseRef: string; headRef?: string }  // a review session (see Review sessions): its base (a commit id, or a branch to take the merge base with, e.g. 'origin/main') and the reviewed commit (a commit id or 'HEAD'; none = the working tree)
}

type Attachment =
  | { kind: 'image'; name: string; mimeType: string; data: string }                  // base64
  | { kind: 'file'; name: string; path?: string; mimeType?: string; text: string }   // text file

type Message = {
  id: string
  sessionId: string
  seq: number                // position in the linear log — source of truth for order
  role: 'user' | 'agent'
  text: string               // what the user sees (no tag); agent: accumulated markdown
  wireText?: string          // user messages: exactly what was sent
  threadId: string | null    // null = main thread
  acpMessageId?: string      // ACP messageId for agent chunks, when provided
  attachments?: Attachment[] // user messages: images and files sent with it
  steered?: boolean          // user messages: injected into a running turn (see Composer → Steer)
  createdAt?: number         // when it was recorded; missing on messages stored before M9
}

type ToolCall = {             // rendered inline in whichever thread it belongs to
  id: string                 // ACP toolCallId
  sessionId: string
  messageSeq: number         // ordering relative to messages
  threadId: string | null
  title: string
  kind?: string
  status: string             // pending | in_progress | completed | failed | cancelled
  content?: unknown
}

type Plan = {                 // the agent's plan for one turn, rendered as a checklist in its thread
  id: string
  sessionId: string
  seq: number                // where it first appeared in the turn; shares the log's sequence
  threadId: string | null
  entries: { content: string; status: 'pending' | 'in_progress' | 'completed'; priority?: string }[]
}

type Thread = {
  id: string
  sessionId: string
  anchorMessageId: string | null  // the agent message the anchor lives in (any thread); null for line anchors
  anchor:
    | { kind: 'listItem'; path: number[]; text: string }               // [2] = 3rd top-level item
    | { kind: 'selection'; start: number; end: number; text: string }  // source-markdown offsets
    | { kind: 'line'; file: string; side: 'old' | 'new'; start: number; end: number;
        text: string; lines: string[] }                                // diff lines; text = the selection, lines = the full lines
  finding?: { severity: 'bug' | 'suggestion' | 'nit'; title: string; body: string }  // opened by the agent's first pass
  resolvedAt?: number        // review threads: resolved by the user
  createdAt: number
}
```

Projects are folders: those opened with "Open project…" (a `projects` table) plus the folders of existing sessions, matched case-insensitively on Windows.

Notes:
- `anchorMessageId` may point at a message inside a thread. That would allow nested threads later without a migration. Nesting is **not** in scope now.
- A Thread row is created when the user sends the first message on an anchor, not when the panel is opened. A finding's thread is the exception: the first pass creates it.
- For an agent that shares its sessions (see Shared sessions), messages, tool calls and plans are a cache of the agent's session. Threads, the thread each message belongs to, titles renamed in Gloss, `model`, `effort`, `steered` and `createdAt` are Gloss's own.

## Message flow

```
send(text, threadId?):
  if a turn is running in this thread and supports steering: steer(text, threadId); return
  if a turn is running elsewhere or cannot steer: queue.push({text, threadId, attachments}); return   (see Composer → Queue)
  t = threads[threadId]
  wire = t ? `[re: "${truncate(t.anchor.text, 80)}"]\n${text}`
           : lastUserMessage()?.threadId != null ? `[re: the main conversation, not the thread above]\n${text}` : text
  insert Message{role:'user', text, wireText: wire, threadId, seq: next()}
  currentThread = threadId
  { stopReason } = await acp.prompt(sessionId, [{type:'text', text: wire}, ...attachmentBlocks])
  if queue not empty:
    stopReason == 'end_turn' ? send(queue.shift()) : pause the queue

on session/update:
  agent_message_chunk  → append to the current agent Message (group by messageId if present,
                         else one agent Message per turn), threadId = currentThread
  tool_call            → insert ToolCall, threadId = currentThread
  tool_call_update     → update ToolCall
  plan                 → the turn's first plan inserts a Plan, threadId = currentThread;
                         later ones in the same turn replace its entries (each lists the whole plan)
  available_commands_update, usage_update, config_option_update, current_mode_update
                       → the session's live state (status line, slash commands), at any time
  anything else        → ignore

on session/request_permission:
  auto-approve (see Permissions): respond { outcome: { outcome: 'selected', optionId: <allow option> } }

steer(text, threadId):                                   (see Composer → Steer)
  if no turn is running: send(text, threadId); return
  require threadId == currentThread
  insert Message{role:'user', text, wireText, threadId, steered: true, seq: next()}
  the next agent chunk starts a new agent Message
  outcome = await _session/steering(sessionId, prompt, idleBehavior 'promptRequired')
  outcome == 'promptRequired' → delete that Message; queue it first

cancel():
  notify session/cancel
  pending prompt resolves with stopReason 'cancelled'
```

### Permissions

Gloss runs agents without permission prompts. There is no approval UI.

- **Bypass mode.** An agent config may name the agent's session mode that skips permission checks (`bypassModeId`; Claude Code: `bypassPermissions`). After `session/new` and `session/load`, if the agent reports that mode among its `modes.availableModes` and it isn't current, Gloss calls `session/set_mode` with it. This is best effort: if the mode isn't offered or the call fails, Gloss logs it and relies on auto-approval.
- **Auto-approval.** Every `session/request_permission` is answered with the agent's `allow_once` option, or `allow_always` if that is the only allow option. `allow_once` is preferred because "always" can make the agent persist a rule (Claude Code writes it to the project's settings). With no allow option, the answer is `cancelled`.

Rendering:
- **Main view:** messages and tool calls with `threadId == null`, in `seq` order. Each anchor in an agent message is decorated with its thread's reply count.
- **Thread panel:** a quote of the anchor text, then messages, tool calls and plans with `threadId == t.id` in `seq` order, then a composer. It is one of the side panel's two views (see Conversation view → Side panel).
- While a turn is running, sending from its active thread steers when supported; messages from other threads queue (see Composer → Queue). Show which thread is running.

## Agent integration: ACP

Use the **Agent Client Protocol** (JSON-RPC over stdio) so the app is agent-agnostic. Use the official TypeScript library `@agentclientprotocol/sdk` (check its examples for the current client API; `ClientSideConnection` is deprecated in favor of `client()`).

Lifecycle:
1. Spawn the agent's ACP entrypoint as a child process.
2. `initialize` — advertise no `fs` and no `terminal` client capabilities for v1, so the agent uses its own file and shell tools. Read `agentCapabilities`: `loadSession`, `promptCapabilities` (what attachments it takes) and `sessionCapabilities` (`list`, `delete`).
3. `session/new` with `cwd`, the global `mcpServers` list and the agent's instructions (see Wire format → Agent instructions).
4. Turns via `session/prompt` as above.
5. On app restart: if the agent advertised `loadSession`, use `session/load` to resume, which also syncs the session (see Shared sessions); otherwise start a new ACP session and show a notice that the agent lost context, and the app's own DB is the display state.

### Authentication

Agent-agnostic, driven entirely by ACP. No agent-specific login code.

- In `initialize`, advertise `clientCapabilities.auth.terminal: true`. Keep the agent's `authMethods` from the response.
- A request failing with ACP's `auth_required` error (JSON-RPC code `-32000`) during session creation or opening shows a "Sign in" prompt listing the agent's `authMethods` by `name` and `description`. During a turn, the failure ends the turn and offers **Sign in** on its notice instead. Clicking it opens that prompt, then resends the original message after successful sign-in.
- Running a method depends on its kind:
  - **Agent method** (no `type`): call `authenticate({ methodId })`. The agent handles the login.
  - **Terminal method** (`type: 'terminal'`): run the agent's own `command` with the method's `args` appended and its `env` merged in, in a visible system terminal window. The login may be interactive, and Gloss has no embedded terminal. Wait for it to exit.
- After a method succeeds, retry the request that failed. If the agent offers no methods, show the error text.
- If the agent never reports `auth_required`, there is no sign-in UI.

Supported agents: **Claude Code** via `@agentclientprotocol/claude-agent-acp`, **Codex** via `@agentclientprotocol/codex-acp`, and a user-installed **OpenCode v2** native executable via `acp`. Both bundled adapters run on Electron's Node runtime; the Codex adapter includes its native CLI and uses the existing Codex login. Codex's bypass mode is `agent-full-access`. Sign-in, model selection, threading and resume use the same ACP paths; steering is shown only when advertised.

**OpenCode setup:** Settings offers an executable path and **Test connection and save**. Empty discovers a native executable on PATH or OpenCode Desktop's versioned Windows CLI installation. New sessions and the default-agent star are disabled for an unavailable OpenCode installation. Connection tests initialize ACP with a 15-second deadline, reject versions before v2, and create no session or model request. Native `.cmd`, `.bat` and PowerShell wrappers are not launched. Provider setup and model discovery belong to OpenCode, including Ollama; Gloss does not manage model downloads or an inference server. A session retains its agent and working directory, and connection failures never switch it to another agent. Changes to the executable restart idle connections and wait for active turns to finish.

**OpenCode instructions:** a Gloss-owned `opencode-instructions.md` in the data directory carries the thread-routing and diff-tag guidance. Its absolute path is appended to `OPENCODE_CONFIG_CONTENT.instructions`, preserving other inline configuration and native project/user configuration files. Existing inline content must be a JSON object. There are no hidden user turns or edits to project instructions. Model identity must not be inferred from skill descriptions. OpenCode v2's modern terminal auth method runs `acp --login`; unsupported steering queues follow-ups, and subscription usage stays unavailable. Runtime verification and setup details are in `docs/OPENCODE.md`.

**New session** starts a session with the default agent, named on the button. Its ▾ opens a menu of the agents: clicking one starts a session with it, and each has a star; starring one makes it the default (one at a time, saved as `defaultAgent`). Every agent's external sessions are listed, each labelled with its agent. Gloss sessions from both agents remain visible with agent labels; the open session's header identifies its agent. A session keeps its original agent. Gloss-managed MCP servers are shared globally across agents (Settings). Each agent retains its own conversations and context.

Agent config is a small table so more agents can be added later:

```ts
type AgentConfig = { id: string; name: string; command: string; args: string[]; env?: Record<string,string>; bypassModeId?: string }
```

Agents inherit Gloss's environment, so a test run can pick a cheap model with `ANTHROPIC_MODEL=haiku`. There is no dev model setting. Judge the threading UX on the normal model; Haiku produces shorter, less list-heavy answers.

## Settings

- **One `settings.json`** in Gloss's data folder (Electron's `userData`, next to the DB), never in a project. Global settings sit at the top level; per-project settings sit under `projects`, keyed by the folder's absolute path (matched case-insensitively on Windows).
- **A JSON Schema**, `settings.schema.json`, is written next to it on every start, generated from the same field table the app validates against (`src/shared/settings.ts`). A new file's `$schema` points at it, so editors autocomplete and validate, and an agent can read what is allowed.
- **Validation** is owned by the main process. Missing keys take their defaults; unknown keys are ignored and kept.
- **Live reload:** the main process watches the folder (editors often replace the file) and applies changes without a restart. If the file has invalid JSON or values, or is deleted, Gloss keeps the last good settings and shows what is wrong (on the settings screen, and a mark on the sidebar's Settings button). It never resets or overwrites the file because of a bad edit.
- **Settings screen** (the sidebar's Settings button, or `Ctrl+,`; Esc or Done closes it): a list of sections on the left (General, Appearance, MCP servers, OpenCode, the open session's project, and Keyboard shortcuts, a read-only list of every shortcut grouped by where it applies, `src/renderer/src/shortcuts.ts`), and one section at a time on the right, under the file's path with "Open in editor" (the system's app for `.json`). Each section is a card of rows: the label and help, then one control (Theme is a three-way segmented control). Changes save immediately: only the changed keys are written, everything else in the file is kept. Saving is refused while the file isn't valid JSON.
- Each feature adds its own fields when it lands; no field appears before its feature exists.
- **Global MCP servers:** `mcpServers` is one global list shared by all agents in every project. It appears under Global in Settings, even without an open project, with Add, Edit, Remove, Import from Claude and Import from Codex. Every listed server is included; there are no enable/disable toggles. Changes apply on the next turn or resume. Entries use ACP stdio, HTTP or SSE configuration; names must remain unique after Codex replaces Unicode whitespace with underscores. Remote URLs use HTTP or HTTPS. Unsupported transports fail visibly (Codex has no SSE). An attached session reloads using close/load before the next prompt or idle resume; a running prompt finishes first. Agents without close/load need an app restart. Explicit Gloss entries take precedence over same-named native Codex entries; other native extensions remain available. Removing an entry from Gloss does not remove native agent configuration.
- **One-time MCP import:** read Claude user/local configuration (`~/.claude.json`, respecting `CLAUDE_CONFIG_DIR`) and project `.mcp.json` files, or Codex `config.toml` (respecting `CODEX_HOME`) and known project `.codex/config.toml` files. Preview candidates with their source, selection and editable import name before saving. Duplicate names are not selected by default, and conflicts must be resolved before importing. Disabled, invalid or unsupported entries are shown with a reason. Do not execute configured commands, copy OAuth sign-ins, or modify agent files. Resolve supported environment references from the current Gloss environment and copy their values once. Restrictions or working-directory settings that ACP cannot preserve block that entry. Legacy `projects[folder].mcpServers` remain readable and can be explicitly imported into the global list; they are no longer applied per project.
- **Fields so far:** `defaultAgent`: `claude` (default) or `codex`, the agent New session uses (set with the star in its menu, so the settings screen doesn't list it), `theme`: `system` (default, follows the OS and updates live), `light` or `dark`, `sessionOrder`: `created` (default, newest first) or `activity` (see Projects and sessions), and `externalEditor`: the command that opens a review's files in your editor, with `{file}` and `{line}` filled in (the path is appended without `{file}`), suggesting `code -g {file}:{line}` and similar; empty (default) opens the file with the system's default app. On Windows it runs through `cmd.exe` (editors are often `.cmd` launchers), so a path containing `%` or `"` is refused. The renderer sets `data-theme` on the document, and main sets Electron's `nativeTheme.themeSource` to the setting, so native parts (the window controls' hover, dialogs) match it.

## Stack

- **Electron**, built with `electron-vite`, TypeScript throughout.
- **Main process** owns everything agent-related: spawning, the ACP connection, persistence. Exposes a narrow IPC API to the renderer:
  - `projects.list() / projects.open() / projects.agentSessions(path, agentId)`
  - `sessions.list() / sessions.create(cwd, agentId) / sessions.import(cwd, agentId, acpSessionId, title) / sessions.open(id) / sessions.rename(id, title) / sessions.delete(id) / sessions.setModel(id, value) / sessions.copyMarkdown(id, threadId) / sessions.saveMarkdown(id, threadId)`
  - `send(sessionId, text, threadId | null, attachments, fromThread?)` (queues while a turn runs; `fromThread`: Send to main), `steer(sessionId, text, threadId | null, attachments)`, `cancel(sessionId)`, `queue.edit(sessionId, id, text) / queue.remove(sessionId, id) / queue.resume(sessionId)`
  - `git.status(cwd)`
  - `threads.create(sessionId, anchorMessageId, anchor)`
  - `history()`: the user's sent messages for the composers' Up and Down
  - `sessions.open` returns the session's messages, tool calls, plans and threads
  - `settings.get() / settings.update(patch) / settings.openFile()`
  - an event stream: message/tool-call/plan upserts, turn start/end, session upserts and deletes, live session state, queue changes, notification clicks, settings changes
- **Renderer** only renders. Framework is the implementer's choice (React is fine).
- **No menu bar** on Windows and Linux (`Menu.setApplicationMenu(null)`). The default menu's zoom shortcuts (`Ctrl+=`, `Ctrl+-`, `Ctrl+0`) are kept, plus DevTools (`F12`, `Ctrl+Shift+I`) and reload (`Ctrl+R`) in development. `F11` toggles full screen: a borderless window over the whole monitor (taskbar included, not exclusive, so Alt+Tab and notifications still work). Entering it shows "Press F11 to exit full screen" for a few seconds; `Esc` doesn't leave it (it closes menus and dialogs), and it isn't remembered across restarts. On macOS the system's own full screen (green button, `Ctrl+Cmd+F`) applies. macOS keeps the default menu: it lives in the system menu bar, and copy and paste need its Edit menu.
- **Title bar:** drawn by the app (`titleBarStyle: 'hidden'`), a 40px strip across the top of the window in the frame's color (`--title-bar`, the same as the sidebar's), that drags the window. It shows the bead and the `gloss` wordmark (`docs/BRAND.md`) at its start, over the sidebar. The system's window controls sit over its end (`titleBarOverlay` on Windows and Linux, in the title bar's color and the theme's ink and updated when the theme changes; the traffic lights over its start on macOS), and the layout keeps clear of them with the `titlebar-area-*` CSS variables. The window title stays "Gloss" (taskbar, Alt+Tab).
- **Security:** agent output is untrusted (it can contain text from files and web pages). `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, expose only the IPC API via `contextBridge`, and **sanitize rendered markdown** (no raw HTML, safe link handling: open external links in the system browser).
  - Markdown links to absolute local files (Windows drive paths, slash-prefixed drive paths, POSIX paths, or local `file:///` URLs) open through the main process in the configured External editor. Optional `:line`, `:line:column`, and `#Lline` suffixes select the line; columns are ignored. Without an editor configured, reveal the file in its folder. Validate the destination again in the main process and require an existing regular file. Never navigate the renderer to a file, launch it through its default application, or accept network paths. Relative links remain plain text; failures appear next to the link.
- **Persistence:** SQLite. Prefer the built-in `node:sqlite` if the Electron version's Node supports it; otherwise `better-sqlite3` with `electron-rebuild`.
- Target platform: Windows first (the developer's machine); don't do anything that prevents macOS/Linux.

## Projects and sessions

The sidebar (`docs/mocks/target.html`) shows one project at a time:

- **Project switcher** at the top: the current project's name and where its folder is (the parent folder, the home folder shortened to ~; the full path in its tooltip). Its menu lists every project (a dot marks one with a running session) and "Open project…", a folder picker that adds a project. Hovering a project in the menu shows a small **×** that deletes it.
- **Delete project** asks for confirmation, then deletes each of the project's sessions that were opened in Gloss as below (the agent's copies too) and removes the project. The agent's sessions that were never opened in Gloss are kept, and the folder's files are not touched.
- **+ New session** starts a session in the current project (`Ctrl+N`). Without a project it opens the folder picker.
- **Sessions:** one list of the project's sessions, newest first, or most recent activity first with the `sessionOrder` setting (a Gloss session by its newest message), each row with one lead slot (a running dot while a turn runs, else a red dot when its last turn failed, or a green one when it finished, while the user wasn't looking (another session open, or Gloss in the background), until it is looked at (opened, or open when Gloss comes to the front) or runs again, else the review icon for a review session, or a hollow ring for the agent's own sessions not opened in Gloss), the title over the agent's name (and a review's open thread count), and the age it is sorted by; the current session has a pink bar. ACP doesn't say when the agent's own sessions began, so those go by their `updatedAt`, and one opened in Gloss keeps that time as its creation, so it keeps its place: those opened in Gloss and, when the agent advertises `sessionCapabilities.list`, the agent's own sessions for the folder from `session/list` with `cwd` (for example ones started in the `claude` CLI). Right-clicking a session, or its **…** button (shown on hover, in place of the age), opens its menu: Rename, Copy as markdown, Save as markdown…, Delete…. Double-click (or F2) renames in place.
- **Opening an agent session Gloss has no record of** creates its record, and the `session/load` replay builds its log: `user_message_chunk` and `agent_message_chunk` become messages (split by `messageId`, and at tool calls), `tool_call`/`tool_call_update` become tool calls, user messages are placed in threads as in Shared sessions. If the load fails, the half-made record is removed.
- **Delete** happens at once (no confirmation), cancels a running turn, calls `session/delete` when the agent advertises `sessionCapabilities.delete` (Claude Code then removes its transcript under `~/.claude/projects`), and removes the session, its messages, tool calls and threads from the DB. If the agent's delete fails, the Gloss copy is still removed and the sidebar says so (unless the session never had a message: Claude Code writes no transcript until the first prompt, so there is nothing to lose).
- **Opening a session resumes it on the agent** in the background (`session/load`), so its model, commands and usage are known before the first message, and syncs it.

## Shared sessions

When the agent advertises `loadSession` (Claude Code does), the agent's own copy of a session is the source of truth for the conversation, and the same session can be continued in Gloss and in the agent's CLI (`claude --resume`), one at a time. Noticing changes made elsewhere also takes `sessionCapabilities.list` and `close`.

- **What lives where.** The agent's session (Claude Code: its transcript under `~/.claude/projects`) decides which messages, tool calls and plans exist and in what order. Gloss's DB caches them for display and search, and adds what a linear session can't hold (see Data model → Notes).
- **Sync.** Each `session/load` replay is matched against the cached log, in order: agent messages by `messageId` (the Claude adapter uses the same ids live and in the replay), user messages by their wire text, tool calls by `toolCallId`. A matched entry keeps its Gloss id, thread and fields, so thread anchors stay valid. An entry the cache doesn't have (sent from elsewhere) is added where the replay has it. A cached entry the agent's session no longer has (a rewound turn, a prompt that never reached the agent) is removed, with the threads anchored on it. Two exceptions:
  - Cached entries before the first one the replay shares are kept: after a compaction, Claude Code's replay starts at its summary, so the replay is no longer the whole history.
  - Plans are kept. The replay's plans are recorded only for turns the cache doesn't have.
- **Claude Code's own messages** are skipped: the summary that starts the history after a compaction ("This session is being continued from a previous conversation…") and the marker of a cancelled turn (`[Request interrupted by user]`). The text of a cancelled turn's answer is taken from the replay, which has more of it than Gloss saw.
- **Messages from elsewhere** are placed by their tag: `[re: "<text>", continued in the main conversation]` for a thread of the session goes to the main thread; `[re: "<text>"]` goes to the thread whose own tag is that line (the most recently active if several match); `[re: the main conversation, not the thread above]` and untagged messages go to the main thread. A tag that matches no thread stays in the text and the message goes to the main thread. The agent's output goes to the thread of the user message before it. Images come back as image chunks; text files come back as text (`[@name](uri)`, then `<context ref="uri">…</context>`) and show as file attachments again. Such messages take the agent's `updatedAt` from before the load as their `createdAt`.
- **When Gloss syncs:** when a session is resumed, and, for a session already running on the agent, when it is opened, when the window regains focus with it open, and before a prompt or queued message is sent. Gloss compares the agent's `updatedAt` for the session (from `session/list`) with `syncedAt`, and reloads the session if it moved: `session/close`, then `session/load`. The close is required: a `session/load` of a session the adapter already holds replays the new history but keeps the running process, whose model doesn't see it. Never while a turn runs; before a send, the turn's own message waits at the end of the log until it goes out. A load changes `updatedAt` itself, and so does each turn, so `syncedAt` is recorded after both. An agent without `session/list` or `session/close` syncs only when resumed.
- **Deleted outside Gloss.** If `session/load` fails because the agent no longer has the session (ACP `resource_not_found`), Gloss deletes it too (messages, threads, queue) and the sidebar says so in a neutral note above the session list, dismissed with its ×. Errors from sidebar actions (creating, importing, deleting) show in the same place, in the failed color. A session that never had a message is the exception: Claude Code writes no transcript until the first prompt, so it gets a new agent session in its place. Missing from `session/list` alone is not enough (the list is paged). Other load failures show the error and are retried on the next open or send; Gloss doesn't start a new agent session in place of one it couldn't load.
- **In the CLI,** messages sent from threads show with their tags, and the threads are flattened into one conversation, which is how the agent sees them anyway.
- **One at a time.** Gloss can't tell when the CLI is using a session. Using it in both at once gives the transcript two writers (Claude Code then branches it), and the next sync shows the branch the agent loads.
- Agents without `loadSession` keep the DB as the display state.

## Conversation view

- **Layout:** the log, composer and status line share one centered column that grows with the pane (820px up to 1080px), and the conversation text grows from 15px to 16px and 17px on wide panes (markdown sizes are relative to it). The thread panel grows with the window too (420px up to 600px). The sidebar and the thread panel can be resized by dragging their inner edge, or by focusing that edge and pressing the arrow keys; double-click resets it. **«** beside the project switcher at the top of the sidebar collapses it to a thin rail (a button that expands it, and a running dot while any session runs); the collapsed state is remembered like the widths. The sidebar stays between 180px and 480px (at most 40% of the window), the thread panel at least 320px while leaving the conversation 360px. Widths are UI state, remembered in the renderer's localStorage, not settings. In a narrow window the panes make room for the conversation's 360px: the thread panel narrows first (down to 320px), then the sidebar (down to 180px). If both are open and that is still not enough, the one opened earlier shows as its rail until the window is wide enough again (this doesn't change the remembered collapsed state); expanding that rail keeps it open and collapses the other instead. The window itself never scrolls; only its panes do.
- **Side panel** (`docs/mocks/target.html#overview`): the right-hand panel is collapsible and shows one of two views.
  - **Collapsed**, it is a thin rail with a threads button, the session's thread count when there are any (in a review session, its open line threads plus one for the general conversation, which the panel also holds) and a running dot while a turn runs in a thread. Clicking it opens the overview. `Ctrl+Shift+T` toggles the panel.
  - **Threads overview:** two tabs, **Threads** and **Queue**, each with its count.
  - **Threads tab:** the session's threads, oldest first. Each row shows its quote (two lines at most), the reply count, the last activity ("5m ago", from its newest message, or the thread's creation for messages stored before M9) "working" while the turn runs there, "queued" ("2 queued") while messages wait to run there, and "paused" when the queue is paused. Clicking a row opens that thread. With no threads, it says how to start one.
  - **Queue tab** (`Ctrl+Shift+Q`): a timeline of the session's messages, each under the name of the thread it runs in ("Main conversation" for the main one). On top, the queued messages, the next one at the bottom, with Edit and Remove as above the composer, and "paused" with **Resume** when the queue is paused; clicking one opens its thread, or focuses the main composer. Below, every message sent in the session (from the log, so after a restart too), newest first, with when it was sent. Each row has a state dot: queued or paused for the waiting ones; working (the running turn's message, also highlighted), completed, cancelled or failed for the sent ones, from its turn outcome (none for turns Gloss didn't run). The turn in progress thus moves up the list. The tab opens scrolled to the line between the two. Clicking a sent message opens its thread (or stays on the main conversation), scrolls to it and highlights it briefly. The thread view's back button then reads **← Queue** and returns here.
  - **Thread names:** a thread is named by the start of what it replies to (the list item's or selection's text, cut to 40 characters), e.g. in the activity strip and the Queue tab. The thread view's header doesn't repeat it, as the quote sits right below.
  - **Thread view:** the thread panel, with **← All threads** to go back to the overview. Reply badges, anchors in the conversation, the status line and notifications open a thread straight into this view, expanding the panel if needed.
  - The panel icon at the header's end (or `Ctrl+Shift+T`) collapses the panel from either view; `Esc` doesn't. Each session remembers the thread its panel showed, so expanding the panel, or coming back to the session, shows it again (while Gloss runs). It always starts collapsed when Gloss launches. Expanded, it uses the thread panel's width and resize handle; the rail has a fixed width.
- **Plans:** an agent's `plan` updates render as a checklist (pending, in progress, done, with "2 of 4 done") in the thread whose turn produced them, at the point the plan first appeared, and update in place as the agent works. A plan is stored, so it survives a restart. Each turn that reports a plan gets its own checklist; an earlier turn's checklist keeps its last state. Claude Code reports its todo list this way; it only gives older models its todo tools by default, so Gloss sets `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` in the Claude agent's environment. A sync records the plans in the replay too, one per user message.
- **Activity strip:** above the main composer once a turn has run: where the agent works (a thread or the main conversation), or where the latest turn ran and its outcome, and queued messages. It is one raised bar; its main part names the place with a state dot: "Working in “thread name”" (or "Working in main conversation") while a turn runs there, then "Done in", "Cancelled in" or "Failed in" from that turn's outcome ("Last worked in", grey, without one). It shows also while the side panel shows that thread. Clicking it opens the thread, or for the main conversation scrolls the log to the bottom and focuses the main composer. "2 queued" sits at its right end and opens the Queue tab (the status line then doesn't repeat it). With neither there is no strip.
- **Turn outcomes:** when a turn ends, the user messages sent in it (the one that started it and any steered in) record how: `completed` (`end_turn`), `cancelled`, or `failed` (an error, or a turn cut short: max tokens, refusal). Stored in the DB (`messages.outcome`), so they survive restarts and syncs that keep the message.
- **Turn notes:** when a turn ends other than normally, a note follows it in the log of the thread it ran in. A failed turn's note is a box in the failed color with an alert icon and the error ("The turn failed: …"); a cancelled turn gets a small grey line ("Cancelled."). A cut-short turn gets a failed notice ("The agent stopped: max tokens."). Failed notices offer **Sign in** for ACP `auth_required`, otherwise **Retry**. Retrying resends the original prompt, with its original thread, attachments and wire context. While recovery is pending its button is disabled; dismissing sign-in or a recovery error leaves it available again with an explanation. A failed retry gets its own notice. Notes and recovery actions are kept only while Gloss runs.
- **State colors:** one color per state everywhere a turn, message or step shows one (`--state-*` in the stylesheet): working blue (pulsing dots, running tool calls, plan steps in progress), completed green (tool calls, plan steps, turn outcomes), queued yellow, paused purple, failed or cancelled red. Not used for things that mean something else: PR badges follow GitHub's colors, and warnings (a rate limit near, a full context) stay amber.
- **Header:** the session title and the agent name. A session is exported from its sidebar menu; the thread panel's header has icon buttons to **Find in main session** (scrolls the main conversation to the thread's anchor and highlights it; not in review sessions, whose conversation that panel replaces) and to **Export** one thread.
- **Export format:** `# Title`, then each message as `**You**` / `**Agent**` and its text, tool calls as `_Tool: title (status)_`, attachments named; for a whole session, each thread with replies follows under `## Thread: “anchor”` with the anchor quoted.
- **Tool calls** of a turn that follow each other share one box, a row each: an icon for the ACP tool kind, the title (a command's in monospace), and a check when done, a pulsing dot while it runs (the agent reports a command it is executing as `pending` too) or "failed". Internal steps the user can't act on (Claude Code's `ToolSearch`) fold into a "Show 1 internal step" line. Rows are collapsed. Clicking expands what the agent did, from the tool call's ACP `content`: a command's full text and its output (the Claude adapter sends output as a console code block when the client has no terminal capability), a file edit (`diff` content) as a unified line diff with unchanged stretches collapsed to 3 lines of context, other content as markdown.
- **Code blocks** are highlighted with Shiki (JavaScript regex engine, no WebAssembly, themes `github-light` and `github-dark` as `light-dark()` colors, so they follow the theme). Common languages load at startup, others the first time they are seen; until then the block renders plain and re-renders when ready. Highlighting splits the same source-offset spans selection anchors use, so anchors in code keep working. Each block has a Copy button.

## Review sessions

A session for checking an agent's work (`docs/mocks/target.html#review`). The center shows the diff of the branch, threads hang off its lines, and the agent reviews first. To the agent it is still one linear session, separate from the session that wrote the code, so the review starts with clean context.

- **Start:** **Review changes** on a project in the sidebar creates a review session with the default agent and sends the first pass straight away. A new review (this or **New review**) opens with only the diff: the sidebar collapsed to its rail, the side panel collapsed (it opens on the general conversation, where the first pass runs) and the file list hidden. From then on each keeps the state it is set to. The session list shows it with a review icon, titled "Review: #N <PR title>" when the branch has an open pull request, else "Review: <branch>", with a count of its open threads. **New review** in a review's header starts a fresh review session of the same range with the same agent (a new agent session, a new first pass); the old one stays in the sidebar with its threads.
- **What is reviewed:** the diff from a **Base** to a **Review** commit, picked in two dropdowns in the header (`Base: merge base with origin/main · 3c3c5f9 ▾ → Review: working tree ▾`) and stored as `review.baseRef` and `review.headRef`.
  - **Review** is **Working tree, including uncommitted** (the default: staged, unstaged and new files, so the agent's fixes show up), **HEAD**, or one of the branch's recent commits. The diff is `git diff <base>` plus untracked files as new files for the working tree, else `git diff <base> <commit>`.
  - **Base** is the **merge base with** a branch (recomputed at each refresh), or a commit (used as is). The dropdown offers the merge base with the default branch, with the open pull request's base branch and with the session's own base branch, then the commits. Each dropdown tags its default entry **default**, and **Reset** beside them, shown while the range differs, goes back to the default base and the working tree.
  - **Default base:** the merge base with the open (or draft) pull request's base branch, `origin/<base>` (fetched when the review starts; the local branch if there is no such remote branch), found with `gh`. Without one, the merge base with the default branch: `origin/HEAD`, else `main`, `master`, `origin/main` or `origin/master` (a clone without `origin/HEAD` may have no local `main`). On the default branch itself the merge base is `HEAD`, so the review shows uncommitted changes.
  - **Commits** listed are the branch's (first parents of `HEAD`), newest first: those since the merge base with the default branch and 20 more, at most 50, with a filter box. The lists refresh when a dropdown opens. A commit's short hash links to its page on GitHub when `origin` is a GitHub remote.
  - **Changing the range** re-reads the diff; threads follow their lines or are marked outdated, as after an edit. The agent is told at the start of the next message sent to it, in a first line only it sees: `[The diff under review is now git diff <base> <commit>.]`.
  - With nothing to review the diff says so. The header also shows file and line counts. The main process reads the diff; the renderer gets it through the preload API.
- **Refresh:** the diff is re-read when the session opens, when the window regains focus with it open, after each tool call that completes and at the end of each turn, so the agent's fixes show up as it makes them.
- **Diff view:** one scroll with every file stacked flush, each under a sticky header (path, "new", *committed*, *uncommitted* or *committed + uncommitted*, two icon buttons with tooltips, **Show in File Explorer** (Reveal in Finder on macOS, Show in folder on Linux) and **Open in external editor** (at the file's first added line, with the `externalEditor` setting), absent for deleted files, then `+` and `−` counts); clicking anywhere else on the header collapses or expands the file, and **Collapse all** / **Expand all** in the review header does every file. The review header's tools are icon buttons with tooltips, in this order: the file list, Collapse/Expand all, Split/Unified, Comments, the open-thread count with its stacked previous/next buttons, then, past a divider, New review. Binary files show as a header only; files over 1,000 changed lines start collapsed. Rows render in blocks of 150 lines that the browser skips while they are off screen (`content-visibility: auto`), so large diffs stay usable. Code is highlighted with the conversation's Shiki setup.
  - **Split or Unified** (two icon buttons), side by side by default. In split view lines don't wrap: each side scrolls sideways on its own, with its scrollbar pinned to the bottom of the view while the file is on screen, and Shift+wheel or a horizontal trackpad scroll over a side moves that side. Below 640 px of diff width, split shows as unified.
  - **More of the file:** each hunk header has buttons that show the unchanged lines hidden around it, in one small widget at the right of each hunk header: two stacked half-height buttons, an up chevron for 10 more lines at the top of the gap, under the previous hunk (from the top of the file before the first), over a down chevron for 10 more at its bottom, over the hunk (up from the end of the file after the last), and beside them an up-and-down chevron for the whole gap; a gap fully shown merges the hunks. **Entire file** (an icon button with a tooltip, beside the open buttons in a modified file's header; highlighted while on) shows every line. The lines come from the file at the reviewed commit (the working tree's file when that is reviewed), read by the main process when first asked for and re-read with the diff. They take threads like the diff's lines (see Line anchors).
  - **File tree:** a collapsible column listing the files (name, folder, counts, open threads) that highlights the file in view and jumps to a file when clicked. Right-clicking a file (not a deleted one) opens a menu with the header's **Show in File Explorer** and **Open in external editor**.
  - Split or unified, the tree's visibility and comment visibility are UI state in the renderer's localStorage.
- **Line anchors:** code selected in the diff, including unchanged lines shown around the hunks, can be replied to as in a message. The anchor records the file, the side (old or new), the line range, the selected text and the full text of those lines. A thread on unchanged lines keeps them shown (from the nearer end of their gap, with 3 lines around them) and re-finds them like any thread, so files with threads are read when the review opens. In split view a selection stays on the side it started on. In unified view a selection that covers both removed and added lines anchors to the new side's lines. A new thread's panel shows the tag it will be sent with (see Wire format).
  - **Right-clicking a selection** opens a menu with **Reply to selection**, **Copy** and **Open in external editor**, which opens the file at the selection's first line (a removed line opens at the line that now follows where it was; absent for deleted files). Right-clicking a line of code outside the selection selects that line, and dragging with the right button held selects every line passed over (in that file, and in split view on that side); releasing opens the same menu on them (not on a blank line).
- **Comment cards:** each thread shows as a card under its last line, on its own side in split view: severity, title, two lines of the finding, reply count, last activity, and "working", **Outdated** or **Resolved**. A thread the user started has no severity ("yours") and is titled by its first message. A colored marker in the gutter at the thread's first line stays when the card is hidden. Cards start expanded; **▴** collapses one to its marker, and clicking a marker expands it again. **Comments** (a speech-bubble toggle) in the header (`Ctrl+Shift+H`) hides every card at once. Clicking a card or marker opens its thread in the side panel and highlights its lines.
- **First pass:** the session's first message, sent by Gloss, asks the agent to review the diff against the base commit (it reads the diff itself) and to answer with a short summary and a fenced `gloss-findings` block: a JSON list of `{ file, side, start, end, severity, title, body }`. When the turn ends, Gloss opens one thread per finding, at its lines, with the finding stored on the thread (`finding`); a later answer in the general conversation that lists findings opens threads for the new ones, and shows the block in the general conversation as a row ("7 findings") instead of JSON. A finding whose lines aren't in the diff is listed there as text. The message Gloss sent shows as a line in the general conversation ("Gloss started the first pass"), not as a user message.
- **Fixes:** the review agent changes files itself when asked in a thread. Its edits appear in the diff at the next refresh.
- **Outdated threads:** at each refresh a thread re-finds its lines by their text on the same side of its file, nearest the old position, and moves with them. When they are gone the thread is **Outdated**: its card stays near where the lines were and shows them struck through. A thread whose file left the diff stays under that file's header, marked "no longer changed". Outdated threads still take replies.
- **Resolve:** a thread has **Resolve** (then **Reopen**) in its header. Resolved threads collapse to a grey marker, dim, and are hidden by the overview's Open filter.
- **Side panel:** the overview starts with a pinned **General conversation** card (the latest agent message, the message count) that opens the main thread in the panel with **← All threads** and the main composer. Below it, the threads grouped by file in diff order and sorted by line, each with its marker, lines, title, severity, replies, last activity and state. Filters: **Open** (default), **Resolved** or **All**, with counts, and a **kinds** menu that checks which kinds are shown (all by default). The thread view adds the severity, `file:lines` and **Resolve** to the header, and quotes the lines with their numbers (struck through when outdated) above the finding's title and the messages. The Queue tab is unchanged.
- **Navigation:** `N` and `P` (outside text fields), or the stacked up and down buttons in the header after "2 of 7 open", go to the next or previous open thread in file and line order: the diff scrolls to it, its card expands if comments are shown, and it opens in the side panel.
- **Export:** a review session exports like any session; each line thread is headed `## Thread: src/main/git.ts:93 “<text>”`.
- **Agent instructions:** a review session's instructions add that `[re: path:line "…"]` tags refer to the diff under review and that the `(old)` side is the base's version.

## Search

- **Search conversations** in the sidebar, or `Ctrl+Shift+F` (`Cmd+Shift+F` on macOS), opens a dialog from anywhere, including settings. Escape or clicking outside closes it; focus stays inside while open and returns on close. The dialog is anchored 32 px from the top of the window; results grow and scroll below the input, keeping it stationary as matches arrive. Search leaves the conversation and running turns in place.
- Search includes all history cached in Gloss: user and agent messages in the main conversation and threads, plus tool titles, textual output and file diffs. Agent sessions that have only been listed become searchable when opened and loaded. Attachments and image payloads are not indexed.
- Choose **Everything**, **Current project** or **Current session**, and filter by **Your messages**, **Agent messages** or **Tool output**. Unavailable scopes are disabled. Words match together in any order; double quotes match a phrase. Search input is literal, with no FTS operators. Search waits 150 ms after input changes and discards superseded responses.
- Results are grouped by session (its title and folder once per group, in the order of the best match), each showing who wrote it (You, Agent, Tool output), where (the thread's quote, or Main conversation) and a highlighted excerpt that shows inline code as code. Results are ordered by relevance, up to 100; the dialog says when more matches exist and suggests refining the query. Loading, empty results and errors are shown explicitly. The arrow keys in the search field move a highlight through the results and Enter opens it; results are reachable with Tab and Enter too.
- Opening a result selects its session, opens its thread if needed, scrolls to the entry and highlights it briefly. Tool results expand their details. A result deleted meanwhile reports an error.
- SQLite FTS5 indexes are maintained in the main process by insert, update and delete triggers, including streaming text, replay syncs, clears and cascading session deletions. An append-only schema migration indexes existing history. The renderer searches through a typed preload IPC call; excerpts are never rendered as HTML.

## Composer

- **Slash commands:** typing `/` at the start offers the agent's `available_commands_update` list (name, argument hint, description), filtered by prefix. Arrow keys move, Enter or Tab completes, Escape dismisses. Enter on an exact match sends it. Gloss adds `/clear`, which it runs itself: the session gets a fresh agent session in place, keeping its title, and the old one is deleted (the agent's copy too, with the session's messages, threads and queue). Refused while a turn runs.
- **Stop:** only the composer of the thread the turn runs in has **Stop**; `Esc` in it does the same unless the slash commands are open. Other composers can only queue. A cancel stops that turn alone: the queue moves on.
- **Queue:** while a turn runs, the composer stays usable: messages from other threads queue, and their composer button reads **Queue** (with a clock icon). If the agent cannot steer, messages from the active thread queue too. Queued messages are listed above the composer of the thread they were written in, the next one to run at the bottom (as in the Queue tab), each with Edit (in place) and Remove, and run in that thread. When a turn ends normally (`end_turn`) or is cancelled, the next queued message is sent straight away. A failed or cut-short turn pauses the queue: the composer and status line show "paused" with **Resume**, and a message sent while paused and idle goes out right away; the queue moves on again after the next turn that ends normally. Removing the last queued message clears the pause. The queue is kept by the main process in memory, so it works for sessions that aren't open but is lost when Gloss quits. Works with any agent (no steering).
- **Steer:** while a turn runs, the active thread's composer button reads **Steer**, and it, Enter and `Ctrl+Enter` inject the message into the running turn instead of queueing it ("skip the tests"). There is no way to queue it instead. Steering is used only when the agent advertises it; otherwise messages queue: the Claude adapter's `_session/steering` extension (`_meta.steering.supported` in `initialize`). Gloss records the message first (marked "steered" in the log) so the agent's answer lands below it, then sends it with `idleBehavior: "promptRequired"`; if the turn ended before it got in, the message is taken back and goes to the front of the queue. Other threads can only queue while a turn runs, so the reply stays in the thread it belongs to.
- **Send to main:** a thread's composer (once the thread exists) also has **Send to main**, in its **…** menu beside the send button, which sends its text and attachments to the main conversation instead, tagged as continuing that thread (see Wire format). It is a main-thread message: it steers when the main conversation is active and steering is supported, queues when another thread is active, and shows in the main conversation. The menu item remains **Send to main**. The side panel stays on the thread.
- **Attachments:** paste or drop images and files on the composer, or pick them with **+**. Images become ACP `image` blocks; text files become embedded `resource` blocks (with a `file://` URI when the file has a path). Only what the agent's `promptCapabilities` allow (`image`, `embeddedContext`); the **+** button and drops are off otherwise. Limits: images 10 MB, files 1 MB and text only. Attachments show as thumbnails or names in the composer and in the sent message.
- **Markdown editor:** the composer's text box is a CodeMirror 6 markdown editor (`@codemirror/lang-markdown`, GFM). The source stays visible and is styled: bold, italics, headings, inline code, links, quotes, with markup characters faded. What the user sees is exactly what the agent receives. Affordances:
  - Enter sends (steering the active thread when supported, otherwise queueing during a turn), except inside a ``` code block (open, or before its closing fence), where it adds a line. `Ctrl+Enter` sends with the same routing, including inside code blocks.
  - Shift+Enter adds a line; in a list or quote it continues the markup: `-`, `*`, `1.` (renumbering the items after it) and `- [ ]`. On an empty item it ends the list. Backspace right after a list marker or `>` removes it.
  - Tab nests the cursor's list item under the one before it (at that item's text column), Shift+Tab moves it out to its parent's level, with its lines and sub-items. Outside a list, Tab moves focus as usual.
  - `Ctrl+B` bold, `Ctrl+I` italic, `Ctrl+E` inline code: wrap the selection, unwrap it when already wrapped, or insert a pair around the cursor. `Ctrl+K` makes the selection a link with the URL selected. Pasting a URL over selected text makes it a link.
  - Undo and redo (`Ctrl+Z`, `Ctrl+Shift+Z` / `Ctrl+Y`) cover all of these.
  - The slash command menu, pasted and dropped attachments, and drafts work as before. The editor grows to 8 lines, then scrolls. Editing a queued message stays a plain text box.
- **Sent messages** render through the same markdown renderer as the agent's replies (no raw HTML, safe links only, highlighted code), with each newline kept as a line break.
- **History:** Up with the caret on the composer's first line replaces its text with the previous message the user sent and starts cycling: from then on Up shows the previous message and Down the next, whatever line the caret is on, with the caret at the end of each; at the oldest, Up does nothing. Down past the newest brings back the draft that was there and stops cycling. Editing the text or moving the caret (a click, Left, Right, Home, End, even where the caret can't move) also stops it: the user is now working on that message, so Up and Down move between its lines until it is sent or the composer is cleared. Every composer shares one history: the user's messages from every session and thread, newest first, each text once (at its latest use), from the DB so it survives restarts (`history()`, at most 500). Text only: attachments aren't recalled. A recalled `/command` doesn't open the slash menu. Editing a recalled message makes it the draft.
- **Drafts:** each composer (a session's main thread, or one thread anchor) keeps its unsent text, attachments and caret position when the user switches to another session or thread and back. Drafts are kept in the renderer's memory, so they are lost when Gloss quits.

## Obsidian project shortcut

The project section of Settings includes **Obsidian vault**, saved as `projects[folder].obsidianVault`. Enter an existing vault's name or ID. Empty or whitespace hides the shortcut. Changes apply live and each project keeps its own vault.

An **Obsidian** logo button (with a vault tooltip and accessible label) appears immediately after the project folder button in both conversation and review status lines. It opens or focuses the configured vault using Obsidian's built-in `obsidian://open?vault=...` protocol. The main process resolves the vault from the session's project settings and encodes its name as a single parameter. Launch failures appear in the status line. Obsidian must be installed and the vault already registered there.

## Status line

A line under the composer for the open session (in a review, a band under the diff). Each item is a 24px pill with an icon or a faint label before its value, and a tooltip saying what it is; the ones that open a picker or panel end in a chevron. The agent's items come first and never wrap: those that don't fit are hidden, right to left. The folder, branch, pull request and Obsidian sit at the right end, and the folder and branch names shorten with an ellipsis. Agent state comes from ACP; the usage popup asks Claude Code or Codex directly, and git details come from local commands:

- "Agent not running" when the session isn't resumed and no turn runs (whether and where the agent works is the activity strip's, and the log's)
- queued messages: "2 queued" (yellow; only where no activity strip shows it, i.e. in a review), or "2 queued, paused · Resume" (purple; clicking resumes)
- context use: "Context", a meter and "4% of 1M", from `usage_update` `used`/`size` (amber from 80%)
- session cost, from `usage_update` `cost`, e.g. "$0.01"
- plan usage limits, Claude Code only: the Claude adapter attaches Claude Code's rate-limit info to `usage_update` as `_meta["_claude/rateLimit"]` (`rateLimitType`, `status`, optional `utilization`, `resetsAt` in Unix seconds), one window per update. Gloss keeps the latest per window and shows each: "5h limit OK" (Claude Code reports no percentage far from the limit), "5h limit 82%" (amber when warned), or "5h limit reached · resets 3:40 PM" (red when reached); weekly windows read "Week limit". The tooltip has the reset time. Agents that don't send it show nothing.
- **Usage popup:** clicking any usage item (context, cost or plan limit) for Claude opens a popup; before usage arrives, a "Usage" button opens it. It shows the current session's context window, then the account's plan, session and weekly limits, per-model limits when reported, and extra usage when enabled. Limits have bars, percentages and reset intervals. The main process asks a short-lived Claude Agent SDK query for `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })`, with no prompt and `persistSession: false`, then closes it. Nothing is added to the conversation or session list, and it works while a turn runs or the allowance is exhausted. Successful results are cached for 30 seconds and concurrent requests share the fetch; fetching times out after 15 seconds. Loading, unavailable limits and errors appear inside the popup, with retry after errors. Escape, an outside click or changing sessions closes it. Context comes from the current session's ACP usage, never the temporary query. The experimental SDK dependency is pinned.
- **Codex usage popup:** the same usage items (or the initial "Usage" button) open the popup for Codex. A short-lived bundled `codex app-server` performs the initialization handshake, reads `account/read`, then `account/rateLimits/read` for subscription accounts, and closes stdin. No thread or turn is created. It displays the account's reported quota windows, named buckets, used percentages and reset times, with context from the real session. API key accounts show unavailable plan limits. Cache and concurrent requests are separate per agent, with the same 30-second freshness, 15-second timeout, loading, retry and dismissal behavior as Claude.
- model: the agent's config option with category `model`, shown by name, except that a `default` option shows its description, which names the model it stands for (Claude Code's "Default (recommended)" shows as e.g. "Opus 5.5"); clicking opens a picker that calls `session/set_config_option`. The choice is saved on the session and re-applied when it is resumed.
- effort, right after the model: the agent's config option with category `thought_level` (Claude Code's "Effort", Codex's "Reasoning effort"), shown by name, e.g. "High" (its tooltip says "Effort"); clicking opens a picker that calls `session/set_config_option`. Its levels depend on the model, and it is hidden when the model has none. Saved on the session and re-applied on resume after the model, when the model offers it. Gloss always shows a real level: when Claude's adapter reports `default` (nothing picked here or in Claude Code's settings), Gloss sets the level the adapter itself recommends (`medium`, else the model's first level), and again after a model switch puts it back on `default`; the picker doesn't offer "Default". Gloss doesn't use the adapter's own way of doing this (the JetBrains AIR `recommendedValue` client capability), because claiming to be an AIR client changes how the adapter sends updates, plans and tool calls.
- permission mode: a shield, "Auto-approve" in its tooltip, when the agent runs in its bypass mode; the same "Auto-approve" spelled out in amber when the agent didn't switch to it and Gloss approves each request
- **Extensions** (a puzzle icon): what the agent loaded, from its commands: commands and skills, and MCP prompts (`mcp:<server>:<prompt>`). When the agent has an `/mcp` command, "Show MCP server status" sends it in the main thread (Claude Code answers with each server's status). Gloss doesn't install or configure extensions.
- the git branch of the session folder with `*` when the tree is dirty (`git status --porcelain --branch` in the main process; hidden outside a repo; refreshed when a session opens and after each turn). When the branch's upstream is on GitHub, clicking it opens the branch there.
- the branch's GitHub pull request, from `gh pr view` in the main process with the user's own `gh` login: "#12 open" colored by state (open, draft, merged, closed), a dot for the combined checks (passing, failing, running) and a tooltip with the title and review decision. Clicking opens it in the browser. Hidden without `gh`, its login, a GitHub remote or a PR. A merged or closed PR shows only while the branch is still at its last commit, so a long-lived branch drops it once new work starts. Refreshed with the branch (the last result per folder and branch shows meanwhile), and every 90 s while its checks run and the window is focused.
- the session folder; clicking opens it in the system file manager (`shell.openPath` in the main process, which looks the folder up by session id rather than taking a path from the renderer)

## Keyboard shortcuts

`Ctrl+Shift+F` search conversations · `Ctrl+N` new session · `Ctrl+Tab` / `Ctrl+Shift+Tab` (or `Ctrl+PageDown` / `Ctrl+PageUp`) next / previous session in the project · `Ctrl+L` focus the composer · `Ctrl+Shift+T` show or hide the side panel · `Ctrl+J` go to where the agent is working, or last worked (the thread of the latest message sent), with the caret in that composer (the main conversation's when it was there; nothing in a session without messages) · `Ctrl+Shift+Q` show the queue · `Ctrl+Shift+H` show or hide comment cards and `N` / `P` next / previous open thread (review sessions) · `Esc` close settings or a menu, or cancel the turn from the working thread's composer · `Ctrl+,` settings. `Cmd` works for `Ctrl` on macOS. The mouse's back and forward buttons, and `Alt+Left` / `Alt+Right`, move through the views visited: a session with its open thread (or none), and the settings screen. Deleted sessions are skipped. On macOS, `Option+arrow` in a text field still moves by word. The settings screen lists these and the shortcuts that apply in one place (composer, queued messages, selections, session list, panel edges); they can't be changed.

## Notifications

When a turn ends or fails while the Gloss window isn't focused, Gloss shows an OS notification (session title; "The agent finished", "The agent replied in a thread" or the error). Cancelled turns don't notify, and neither does a turn whose queued follow-up starts straight away. Clicking it focuses the window and opens the session and thread. Tool completion, turn completion and history sync never focus the window, change the selected session or thread, close Settings, or move the caret. On Windows the taskbar button does not flash. The taskbar icon carries a small badge (a plain 8 px overlay dot in the in-app state colors, with transparent padding and no white ring): red while a session has an unseen failure, else green while one has an unseen finish (the sidebar's red and green dots), else blue while any turn runs, else none. It clears once every finished session has been looked at. Where the OS has a dock badge (macOS, some Linux docks) it counts the unseen sessions instead. Windows needs an AppUserModelID for notifications to show.

The same finishes (not cancelled, no queued follow-up) play a short chime, synthesized with Web Audio, when the window isn't focused or the session isn't the open one. The notification itself is silent, so the system's sound doesn't double it. The **Sound when a turn finishes** setting (on by default) turns the chime off.

## UX reference

See `docs/mocks/`:
- `target.html` — the target interface (M12), every screen in light and dark: welcome, a project with no session, a new session, a session with a thread, the selection popover, the threads overview and queue tab, a failed turn, sign-in, search, settings and a review session. Pick a screen at the top (or link one as `target.html#review`). It is the reference for layout and the visual design.
- `design-system.html` — the visual language (M12): type, color roles, surfaces, buttons, icons (Lucide), inputs, menus, rows, code and tool calls, spacing, radii and motion. Its tokens are the stylesheet's.
- `depth.html` — the sheen and depth explorations (M12); option C, Gloss, was chosen and is the one `target.html` uses: the title bar and sidebar are the window's frame, the panes one sheet laid on it, light on raised things' top edges, pressed-in wells and a lacquered primary button.
- `brand.html` — the brand explorations; `docs/BRAND.md` records what was decided.
