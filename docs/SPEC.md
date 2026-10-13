# Gloss — Spec

**Gloss** = **G**raphical **L**ayer **O**ver **S**hell **S**essions
(also: **G**oodbye, **L**ong **O**ff-topic **S**crolling **S**essions)

A *gloss* is a medieval annotation written in the margin beside the specific line it explains — which is what a thread here is.

A desktop GUI for coding agents whose main feature is **threaded replies to individual points** in an agent's response. When the agent returns a multi-point answer (a numbered list of findings, ideas, issues), the user can open a thread on any point, discuss it in a side panel, and come back to the main conversation without scrolling past dozens of turns.

## Core idea: threading is view-only

The agent sees **one linear session**. Threads exist only in the UI.

- Each message is tagged with a `threadId` (`null` = main thread). The UI groups messages by it.
- A message sent from a thread is prefixed with a short tag quoting the anchor, so the agent knows what it refers to. This automates what the user does today by copy-pasting the bullet point.
- The agent's reply is routed to the thread the last prompt came from. Turns are sequential (a message sent during a turn waits in a queue until it ends), so routing is unambiguous.

Consequences, all intended:
- No forking, no merging, no summaries. The agent has everything that happened in every thread in its context.
- One working tree. Edits made from any thread are visible everywhere.
- Works with any agent, because the agent session is not modified.

## Anchors (what a thread hangs off)

Anchors live on **agent messages**. Two kinds:

1. **List item** (one click). Every top-level list item in a rendered agent message gets a reply affordance (a "Reply" button on hover, or a reply-count badge once a thread exists).
2. **Text selection** (fallback). Selecting any text in an agent message (prose, code, a list item) shows a "Reply to selection" popover. The selected span becomes the anchor.

Anchor positions are stored as offsets into the **source markdown**, not the DOM. Use the markdown renderer's source-position info (e.g. mdast `position` in remark/unified, or `map` in markdown-it) to map the DOM selection back to source offsets. Also store the anchor's text so it can be re-found if offsets drift.

## Wire format

User message in a thread is sent to the agent as:

```
[re: "<anchor text, truncated to ~80 chars>"]
<user's text>
```

Main-thread messages are sent unchanged. The UI shows the user's text without the tag; the tag is stored in `wireText`.

## Data model

```ts
type Session = {
  id: string
  agentId: string            // which agent config, e.g. 'claude'
  acpSessionId: string       // the ACP session id
  cwd: string                // its project (folder)
  title: string
  createdAt: number
  model?: string             // model config value picked in Gloss; re-applied on resume
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

type Thread = {
  id: string
  sessionId: string
  anchorMessageId: string    // the agent message the anchor lives in (any thread)
  anchor:
    | { kind: 'listItem'; path: number[]; text: string }               // [2] = 3rd top-level item
    | { kind: 'selection'; start: number; end: number; text: string }  // source-markdown offsets
  createdAt: number
}
```

Projects are folders: those opened with "Open project…" (a `projects` table) plus the folders of existing sessions, matched case-insensitively on Windows.

Notes:
- `anchorMessageId` may point at a message inside a thread. That would allow nested threads later without a migration. Nesting is **not** in scope now.
- A Thread row is created when the user sends the first message on an anchor, not when the panel is opened.

## Message flow

```
send(text, threadId?):
  if a turn is running: queue.push({text, threadId, attachments}); return   (see Composer → Queue)
  t = threads[threadId]
  wire = t ? `[re: "${truncate(t.anchor.text, 80)}"]\n${text}` : text
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
  available_commands_update, usage_update, config_option_update, current_mode_update
                       → the session's live state (status line, slash commands), at any time
  anything else        → ignore

on session/request_permission:
  auto-approve (see Permissions): respond { outcome: { outcome: 'selected', optionId: <allow option> } }

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
- **Thread panel:** a quote of the anchor text, then messages and tool calls with `threadId == t.id` in `seq` order, then a composer.
- While a turn is running, sending from any composer queues the message (see Composer → Queue). Show which thread is running.

## Agent integration: ACP

Use the **Agent Client Protocol** (JSON-RPC over stdio) so the app is agent-agnostic. Use the official TypeScript library `@agentclientprotocol/sdk` (check its examples for the current client API; `ClientSideConnection` is deprecated in favor of `client()`).

Lifecycle:
1. Spawn the agent's ACP entrypoint as a child process.
2. `initialize` — advertise no `fs` and no `terminal` client capabilities for v1, so the agent uses its own file and shell tools. Read `agentCapabilities`: `loadSession`, `promptCapabilities` (what attachments it takes) and `sessionCapabilities` (`list`, `delete`).
3. `session/new` with `cwd` and `mcpServers: []`.
4. Turns via `session/prompt` as above.
5. On app restart: if the agent advertised `loadSession`, use `session/load` to resume; otherwise start a new ACP session and show a notice that the agent lost context. The app's own DB is always the display state.

### Authentication

Agent-agnostic, driven entirely by ACP. No agent-specific login code.

- In `initialize`, advertise `clientCapabilities.auth.terminal: true`. Keep the agent's `authMethods` from the response.
- A request failing with ACP's `auth_required` error (JSON-RPC code `-32000`), from `session/new`, `session/load` or `session/prompt`, shows a "Sign in" prompt listing the agent's `authMethods` by `name` and `description`.
- Running a method depends on its kind:
  - **Agent method** (no `type`): call `authenticate({ methodId })`. The agent handles the login.
  - **Terminal method** (`type: 'terminal'`): run the agent's own `command` with the method's `args` appended and its `env` merged in, in a visible system terminal window. The login may be interactive, and Gloss has no embedded terminal. Wait for it to exit.
- After a method succeeds, retry the request that failed. If the agent offers no methods, show the error text.
- If the agent never reports `auth_required`, there is no sign-in UI.

First agent: **Claude Code via its ACP adapter** (the Claude Agent SDK adapter, originally from Zed). Verify the current package name and entrypoint before wiring it up.

Agent config is a small table so more agents can be added later:

```ts
type AgentConfig = { id: string; name: string; command: string; args: string[]; env?: Record<string,string>; bypassModeId?: string }
```

### Dev model

In development, spawn the Claude adapter with `ANTHROPIC_MODEL=haiku` in its environment so test prompts are cheap. It is a global setting (`devModel`, see Settings), on by default in development builds and off in packaged ones, not a per-project setting. Changing it restarts the agents (busy ones once their turn ends). Judge the threading UX on the normal model; Haiku produces shorter, less list-heavy answers.

## Settings

- **One `settings.json`** in Gloss's data folder (Electron's `userData`, next to the DB), never in a project. Global settings sit at the top level; per-project settings sit under `projects`, keyed by the folder's absolute path (matched case-insensitively on Windows).
- **A JSON Schema**, `settings.schema.json`, is written next to it on every start, generated from the same field table the app validates against (`src/shared/settings.ts`). A new file's `$schema` points at it, so editors autocomplete and validate, and an agent can read what is allowed.
- **Validation** is owned by the main process. Missing keys take their defaults; unknown keys are ignored and kept.
- **Live reload:** the main process watches the folder (editors often replace the file) and applies changes without a restart. If the file has invalid JSON or values, or is deleted, Gloss keeps the last good settings and shows what is wrong (on the settings screen, and a mark on the sidebar's Settings button). It never resets or overwrites the file because of a bad edit.
- **Settings screen** (the sidebar's Settings button, or `Ctrl+,`; Esc or Done closes it): the file's path with "Open in editor" (the system's app for `.json`), then a Global section and a Project section for the open session's folder. Changes save immediately: only the changed keys are written, everything else in the file is kept. Saving is refused while the file isn't valid JSON.
- Each feature adds its own fields when it lands; no field appears before its feature exists.
- **Fields so far:** `devModel` (see Dev model) and `theme`: `system` (default, follows the OS and updates live), `light` or `dark`. The renderer sets `data-theme` on the document; the dark palette is provisional until the M12 design system.

## Stack

- **Electron**, built with `electron-vite`, TypeScript throughout.
- **Main process** owns everything agent-related: spawning, the ACP connection, persistence. Exposes a narrow IPC API to the renderer:
  - `projects.list() / projects.open() / projects.agentSessions(path, agentId)`
  - `sessions.list() / sessions.create(cwd, agentId) / sessions.import(cwd, agentId, acpSessionId, title) / sessions.open(id) / sessions.rename(id, title) / sessions.delete(id) / sessions.setModel(id, value) / sessions.copyMarkdown(id, threadId) / sessions.saveMarkdown(id, threadId)`
  - `send(sessionId, text, threadId | null, attachments)` (queues while a turn runs), `cancel(sessionId)`, `queue.edit(sessionId, id, text) / queue.remove(sessionId, id) / queue.resume(sessionId)`
  - `git.status(cwd)`
  - `threads.create(sessionId, anchorMessageId, anchor)`
  - `settings.get() / settings.update(patch) / settings.openFile()`
  - an event stream: message/tool-call upserts, turn start/end, session upserts and deletes, live session state, queue changes, notification clicks, settings changes
- **Renderer** only renders. Framework is the implementer's choice (React is fine).
- **No menu bar** on Windows and Linux (`Menu.setApplicationMenu(null)`). The default menu's zoom shortcuts (`Ctrl+=`, `Ctrl+-`, `Ctrl+0`) are kept, plus DevTools (`F12`, `Ctrl+Shift+I`) and reload (`Ctrl+R`) in development. macOS keeps the default menu: it lives in the system menu bar, and copy and paste need its Edit menu.
- **Security:** agent output is untrusted (it can contain text from files and web pages). `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, expose only the IPC API via `contextBridge`, and **sanitize rendered markdown** (no raw HTML, safe link handling: open external links in the system browser).
- **Persistence:** SQLite. Prefer the built-in `node:sqlite` if the Electron version's Node supports it; otherwise `better-sqlite3` with `electron-rebuild`.
- Target platform: Windows first (the developer's machine); don't do anything that prevents macOS/Linux.

## Projects and sessions

The sidebar (`docs/mocks/sidebar-switcher.html`) shows one project at a time:

- **Project switcher** at the top: the current project's name and path. Its menu lists every project (a dot marks one with a running session) and "Open project…", a folder picker that adds a project. Hovering a project in the menu shows a small **×** that deletes it.
- **Delete project** asks for confirmation, then deletes each of the project's Gloss sessions as below (the agent's copies too) and removes the project. The agent's sessions that were never opened in Gloss are kept, and the folder's files are not touched.
- **+ New session** starts a session in the current project (`Ctrl+N`). Without a project it opens the folder picker.
- **Sessions:** the project's Gloss sessions, newest first, with a running dot or their age. Right-clicking a session opens its menu: Rename, Copy as markdown, Save as markdown…, Delete…. Double-click (or F2) renames in place.
- **Not in Gloss yet:** the agent's own sessions for the folder that Gloss hasn't imported, from `session/list` with `cwd` (when the agent advertises `sessionCapabilities.list`), newest first, five shown with "Show N more". Clicking one imports it. The section is hidden while loading and when there are none.
- **Import:** a Gloss session is created for the agent's session and its main thread is built from the `session/load` replay: `user_message_chunk` and `agent_message_chunk` become messages (split by `messageId`, and at tool calls), `tool_call`/`tool_call_update` become tool calls, images in user chunks become attachments. If the load fails, the half-made session is removed. Importing the same agent session again opens the existing Gloss session.
- **Delete** asks for confirmation, cancels a running turn, calls `session/delete` when the agent advertises `sessionCapabilities.delete` (Claude Code then removes its transcript under `~/.claude/projects`), and removes the session, its messages, tool calls and threads from the DB. If the agent's delete fails, the Gloss copy is still removed and the sidebar says so (unless the session never had a message: Claude Code writes no transcript until the first prompt, so there is nothing to lose).
- **Opening a session resumes it on the agent** in the background (`session/load`), so its model, commands and usage are known before the first message.

## Conversation view

- **Layout:** the log, composer and status line share one centered column that grows with the pane (820px up to 1080px), and the conversation text grows from 15px to 16px and 17px on wide panes (markdown sizes are relative to it). The thread panel grows with the window too (420px up to 600px). The sidebar and the thread panel can be resized by dragging their inner edge, or by focusing that edge and pressing the arrow keys; double-click resets it. The sidebar stays between 180px and 480px (at most 40% of the window), the thread panel at least 320px while leaving the conversation 360px. Widths are UI state, remembered in the renderer's localStorage, not settings.
- **Header:** the session title and the agent name. A session is exported from its sidebar menu; the thread panel has an **Export** menu for one thread.
- **Export format:** `# Title`, then each message as `**You**` / `**Agent**` and its text, tool calls as `_Tool: title (status)_`, attachments named; for a whole session, each thread with replies follows under `## Thread: “anchor”` with the anchor quoted.
- **Tool calls** show as one row (title, status), collapsed. Clicking expands what the agent did, from the tool call's ACP `content`: a command's full text and its output (the Claude adapter sends output as a console code block when the client has no terminal capability), a file edit (`diff` content) as a unified line diff with unchanged stretches collapsed to 3 lines of context, other content as markdown.
- **Code blocks** are highlighted with Shiki (JavaScript regex engine, no WebAssembly, themes `github-light` and `github-dark` as `light-dark()` colors, so they follow the theme). Common languages load at startup, others the first time they are seen; until then the block renders plain and re-renders when ready. Highlighting splits the same source-offset spans selection anchors use, so anchors in code keep working. Each block has a Copy button.

## Composer

- **Slash commands:** typing `/` at the start offers the agent's `available_commands_update` list (name, argument hint, description), filtered by prefix. Arrow keys move, Enter or Tab completes, Escape dismisses. Enter on an exact match sends it.
- **Queue:** while a turn runs, the composer stays usable: its button reads **Queue** (next to Cancel) and a message sent then is queued instead of sent. Queued messages are listed above the composer of the thread they were written in, each with Edit (in place) and Remove, and run in that thread. When a turn ends normally (`end_turn`), the next queued message is sent straight away. A cancelled, failed or cut-short turn pauses the queue: the composer and status line show "paused" with **Resume**, and a message sent while paused and idle goes out right away; the queue moves on again after the next turn that ends normally. Removing the last queued message clears the pause. The queue is kept by the main process in memory, so it works for sessions that aren't open but is lost when Gloss quits. Works with any agent (no steering).
- **Attachments:** paste or drop images and files on the composer, or pick them with **+**. Images become ACP `image` blocks; text files become embedded `resource` blocks (with a `file://` URI when the file has a path). Only what the agent's `promptCapabilities` allow (`image`, `embeddedContext`); the **+** button and drops are off otherwise. Limits: images 10 MB, files 1 MB and text only. Attachments show as thumbnails or names in the composer and in the sent message.

## Status line

A line under the composer for the open session. Everything but the git branch comes from ACP:

- turn state ("Working…", or "Working in item 2", which opens that thread); "Agent not running" when the session isn't resumed
- queued messages: "2 queued", or "2 queued, paused · Resume" (amber; clicking resumes)
- context use: a meter and percentage of the window, from `usage_update` `used`/`size` (amber from 80%)
- session cost, from `usage_update` `cost`
- plan usage limits, Claude Code only: the Claude adapter attaches Claude Code's rate-limit info to `usage_update` as `_meta["_claude/rateLimit"]` (`rateLimitType`, `status`, optional `utilization`, `resetsAt` in Unix seconds), one window per update. Gloss keeps the latest per window and shows each: "5h ok" (Claude Code reports no percentage far from the limit), "5h 82%" (amber when warned), or "5h limit · resets 3:40 PM" (red when reached). The tooltip has the reset time; clicking runs `/usage` for the full breakdown. Agents that don't send it show nothing.
- model: the agent's config option with category `model`, shown by name, except that a `default` option shows its description, which names the model it stands for (Claude Code's "Default (recommended)" shows as e.g. "Opus 5.5"); clicking opens a picker that calls `session/set_config_option`. The choice is saved on the session and re-applied when it is resumed. While the dev model is on, this shows "Haiku (dev)" and can't be changed.
- permission mode: "bypass", or "auto-approving" (a warning) when the agent didn't switch to its bypass mode
- **Extensions:** what the agent loaded, from its commands: commands and skills, and MCP prompts (`mcp:<server>:<prompt>`). When the agent has an `/mcp` command, "Show MCP server status" sends it in the main thread (Claude Code answers with each server's status). Gloss doesn't install or configure extensions.
- the git branch of the session folder with `*` when the tree is dirty (`git status --porcelain --branch` in the main process; hidden outside a repo; refreshed when a session opens and after each turn)
- the session folder

## Keyboard shortcuts

`Ctrl+N` new session · `Ctrl+Tab` / `Ctrl+Shift+Tab` (or `Ctrl+PageDown` / `Ctrl+PageUp`) next / previous session in the project · `Ctrl+L` focus the composer · `Esc` close the thread panel, settings or a menu · `Ctrl+,` settings. `Cmd` works for `Ctrl` on macOS.

## Notifications

When a turn ends or fails while the Gloss window isn't focused, Gloss shows an OS notification (session title; "The agent finished", "The agent replied in a thread" or the error). Cancelled turns don't notify, and neither does a turn whose queued follow-up starts straight away. Clicking it focuses the window and opens the session and thread. Unseen finishes also set the dock badge where the OS has one (macOS, some Linux docks) and flash the taskbar button on Windows; focusing the window clears them. Windows needs an AppUserModelID for notifications to show.

## UX reference

See `docs/mocks/`:
- `main-view.html` — session list, main thread with a numbered agent reply, reply-count badges / hover "Reply" on items, thread panel on the right. Clickable.
- `selection-anchor.html` — the selection popover and a new thread started from a selection, plus an existing inline anchor (dotted underline + count chip).
- `sidebar-switcher.html` — the sidebar: project switcher, the project's sessions, and the agent's sessions not yet in Gloss.

The mocks show layout and interaction, not a final visual design.
