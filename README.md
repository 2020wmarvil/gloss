# Gloss

**G**raphical **L**ayer **O**ver **S**hell **S**essions

*Goodbye, Long Off-topic Scrolling Sessions.*

A desktop GUI for coding agents (using [Agent Client Protocol](https://agentclientprotocol.com)) that lets you reply to a single point in an agent's answer as its own thread, without scrolling past forty turns about item 1 to find item 2 again.

The agent still sees one linear conversation. Threads are just how Gloss shows it to you.

> A *gloss* is a note written in the margin of a manuscript, beside the exact line it explains.

## Status

**Claude Code and Codex support.** Reply to any top-level list item, or to any text you select (prose or code), in an agent's answer as its own thread, in a side panel, while the main conversation stays short. Also: sessions in a project folder, streamed markdown replies, tool-call rows, cancel, persistence across restarts with the agent resuming where it left off, in-app sign-in, and CI. See [`docs/MILESTONES.md`](docs/MILESTONES.md).

**No permission prompts.** Gloss runs the agent in its bypass-permissions mode and approves any permission request it still gets. The agent can edit any file and run any command it decides to, in the session's folder and beyond, without asking. Only use it where you're comfortable with that.

## Requirements

- Node.js 22 or newer and npm (for development only; the agent runs on Electron's bundled Node).
- A Claude account for Claude Code, or a ChatGPT account with Codex access for Codex. Codex uses the existing Codex login; otherwise choose **ChatGPT** in the sign-in dialog to sign in through your browser. The adapter includes the Codex CLI, so no separate CLI install is needed.
- For Claude Code: If the agent isn't signed in, Gloss shows a **Sign in** dialog with the agent's own sign-in options and opens a terminal window to complete it. It uses the same login as the `claude` command, so if `claude` already works, you're set.

## Getting started

```bash
npm install
npm run dev
```

The first run downloads the Electron binary. Open a project folder, choose **Claude Code** or **Codex** in the sidebar, then click **New session**. Set **Default agent** in Settings to choose the initial selection. Existing sessions keep their agent. Enter sends; Shift+Enter adds a new line.

### Threads

Hover a numbered or bulleted item in the agent's answer and click **Reply** to open a thread on it in the side panel. Your first message creates the thread; after that the item shows a reply count you can click to reopen it. Esc or × closes the panel.

To reply to anything else, select text in an agent message (a phrase, part of a code block) and click **Reply to selection** or press **R**. Anchored text gets a dotted underline and a reply-count chip; click either to reopen the thread.

Threads exist only in Gloss. The agent sees one conversation: a message sent from a thread is prefixed with `[re: "<the item's text>"]` (shown under the thread's composer) and its reply is shown in that thread. One turn runs at a time; while it runs, the header says which thread it belongs to.

### Search

Click **Search conversations** in the sidebar or press **Ctrl+Shift+F** (**Cmd+Shift+F** on macOS). Search messages and tool output across everything, the current project, or the current session. Put a phrase in double quotes for an exact phrase match. Open a result to jump to the message or expanded tool call, including its thread.

Search covers history already loaded into Gloss. Open an agent session from the sidebar to include its history.

### Shared tools and agent handoffs

In **Settings > Project > MCP servers**, configure tools once for both Claude Code and Codex. The editor accepts a JSON list with examples for stdio and HTTP servers. Save it there or edit `settings.json`; changes apply on the next turn or idle resume. Unsupported transports show an error (Codex does not support SSE).

Choose **Continue with...** in an idle conversation or thread to hand work to another agent. The source agent writes a summary for review; if it has exhausted its usage, Gloss uses a local blurb. The destination receives that summary and a path to a saved transcript containing messages, tool output and text attachments (images are listed by name). A thread handoff includes only that thread and its anchor. The destination has **Open source** to return to the original conversation or thread.

### Dev model toggle

**Dev model (Haiku)**, in Settings, runs Claude Code with `ANTHROPIC_MODEL=haiku` so test prompts are cheap. It is on by default in development and stored in `settings.json` in Electron's user-data folder. Changing it restarts idle agents; a running turn finishes on the old model. It does not override Codex models. Judge the threading UX on the normal model; Haiku gives shorter, less list-heavy answers.

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
    anchors.ts    Finds top-level list items in an agent message's markdown source
    source.ts     Maps rendered text to source offsets; re-finds anchors by text
    sourceSpans.ts  Remark plugin: source-offset spans, anchor underlines and chips
    selection.ts  Maps a DOM selection to source offsets
    ThreadPanel.tsx  The thread side panel
  shared/     Types shared across processes (data model, IPC contract, wire format)
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
