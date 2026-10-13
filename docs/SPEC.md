# Gloss — Spec

**Gloss** = **G**raphical **L**ayer **O**ver **S**hell **S**essions
(also: **G**oodbye, **L**ong **O**ff-topic **S**crolling **S**essions)

A *gloss* is a medieval annotation written in the margin beside the specific line it explains — which is what a thread here is.

A desktop GUI for coding agents whose main feature is **threaded replies to individual points** in an agent's response. When the agent returns a multi-point answer (a numbered list of findings, ideas, issues), the user can open a thread on any point, discuss it in a side panel, and come back to the main conversation without scrolling past dozens of turns.

## Core idea: threading is view-only

The agent sees **one linear session**. Threads exist only in the UI.

- Each message is tagged with a `threadId` (`null` = main thread). The UI groups messages by it.
- A message sent from a thread is prefixed with a short tag quoting the anchor, so the agent knows what it refers to. This automates what the user does today by copy-pasting the bullet point.
- The agent's reply is routed to the thread the last prompt came from. Turns are sequential (Send is disabled during a turn), so routing is unambiguous.

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
  cwd: string
  title: string
  createdAt: number
}

type Message = {
  id: string
  sessionId: string
  seq: number                // position in the linear log — source of truth for order
  role: 'user' | 'agent'
  text: string               // what the user sees (no tag); agent: accumulated markdown
  wireText?: string          // user messages: exactly what was sent
  threadId: string | null    // null = main thread
  acpMessageId?: string      // ACP messageId for agent chunks, when provided
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

Notes:
- `anchorMessageId` may point at a message inside a thread. That would allow nested threads later without a migration. Nesting is **not** in scope now.
- A Thread row is created when the user sends the first message on an anchor, not when the panel is opened.

## Message flow

```
send(text, threadId?):
  t = threads[threadId]
  wire = t ? `[re: "${truncate(t.anchor.text, 80)}"]\n${text}` : text
  insert Message{role:'user', text, wireText: wire, threadId, seq: next()}
  currentThread = threadId
  ui.sendDisabled = true
  { stopReason } = await acp.prompt(sessionId, [{type:'text', text: wire}])
  ui.sendDisabled = false

on session/update:
  agent_message_chunk  → append to the current agent Message (group by messageId if present,
                         else one agent Message per turn), threadId = currentThread
  tool_call            → insert ToolCall, threadId = currentThread
  tool_call_update     → update ToolCall
  plan                 → render in currentThread (optional for v1)
  anything else        → ignore for v1

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
- Send is disabled everywhere while a turn is running. Show which thread is running.

## Agent integration: ACP

Use the **Agent Client Protocol** (JSON-RPC over stdio) so the app is agent-agnostic. Use the official TypeScript library `@agentclientprotocol/sdk` (check its examples for the current client API; `ClientSideConnection` is deprecated in favor of `client()`).

Lifecycle:
1. Spawn the agent's ACP entrypoint as a child process.
2. `initialize` — advertise no `fs` and no `terminal` client capabilities for v1, so the agent uses its own file and shell tools. Read `agentCapabilities` (notably `loadSession`).
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

## Stack

- **Electron**, built with `electron-vite`, TypeScript throughout.
- **Main process** owns everything agent-related: spawning, the ACP connection, persistence. Exposes a narrow IPC API to the renderer:
  - `sessions.list() / sessions.create(cwd, agentId) / sessions.open(id)`
  - `send(sessionId, text, threadId | null)`, `cancel(sessionId)`
  - `threads.create(sessionId, anchorMessageId, anchor)`
  - `settings.get() / settings.update(patch) / settings.openFile()`
  - an event stream: message/tool-call upserts, turn start/end, settings changes
- **Renderer** only renders. Framework is the implementer's choice (React is fine).
- **Security:** agent output is untrusted (it can contain text from files and web pages). `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, expose only the IPC API via `contextBridge`, and **sanitize rendered markdown** (no raw HTML, safe link handling: open external links in the system browser).
- **Persistence:** SQLite. Prefer the built-in `node:sqlite` if the Electron version's Node supports it; otherwise `better-sqlite3` with `electron-rebuild`.
- Target platform: Windows first (the developer's machine); don't do anything that prevents macOS/Linux.

## UX reference

See `docs/mocks/`:
- `main-view.html` — session list, main thread with a numbered agent reply, reply-count badges / hover "Reply" on items, thread panel on the right. Clickable.
- `selection-anchor.html` — the selection popover and a new thread started from a selection, plus an existing inline anchor (dotted underline + count chip).

The mocks show layout and interaction, not a final visual design.
