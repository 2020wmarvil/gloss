# Milestones

Build in order. Stop at the end of each milestone, show what works and how to try it, and wait for review before starting the next.

## M1 — ACP spike
- Electron + electron-vite + TypeScript scaffold, secure defaults (see SPEC → Stack → Security).
- Main process spawns the Claude Code ACP adapter, runs `initialize` and `session/new`, sends one hard-coded prompt, and logs `session/update` notifications and the final `stopReason`.
- Dev toggle that sets `ANTHROPIC_MODEL=haiku` on the spawned process.
- Log the agent's advertised capabilities (especially `loadSession`).

**Done when:** `npm run dev` opens a window and a prompt round-trips through the adapter with streamed output visible (console or a bare page is fine).

## M2 — Linear chat
- Renderer: session list, one conversation view, composer.
- Streamed agent text rendered as sanitized markdown; tool calls shown as compact rows (title + status).
- SQLite persistence for sessions, messages, tool calls. Reopening the app shows past sessions.
- Send disabled while a turn runs; Cancel button that sends `session/cancel`.
- Resume via `session/load` when supported; otherwise a clear "new agent session" notice.
- Agent-agnostic sign-in from ACP `authMethods` when a request fails with `auth_required` (see SPEC → Authentication).

**Done when:** a normal multi-turn session with Claude Code works end to end and survives an app restart (display at minimum), and an expired login can be fixed from inside the app.

## M3 — List-item threads (the core feature)
- Top-level list items in agent messages get a hover "Reply" button; items with a thread show a reply-count badge.
- Thread side panel: anchor quote, thread messages, composer.
- Wire tag `[re: "…"]` on send; routing of the reply (text and tool calls) to `currentThread`.
- `threadId` persisted; main view hides thread messages.
- Indicator showing which thread a running turn belongs to.

**Done when:** you can ask for a review, open threads on two different items, have a back-and-forth in each, and the main view stays short.

## M4 — Selection anchors
- Map a DOM selection inside an agent message to source-markdown offsets.
- "Reply to selection" popover (also keyboard: `R`).
- Inline marker for existing selection anchors (dotted underline + count chip) that opens the thread.
- Re-find anchors by stored text if offsets don't match after re-render.

**Done when:** threads can be started from arbitrary prose or code spans and reopened from their inline markers.

## M5 — Misc
- Drop permission prompts (SPEC → Permissions): switch sessions to the agent's bypass mode when it has one, and auto-approve permission requests.
- CI: GitHub Actions running typecheck, lint, tests and the build on Windows and Linux for pull requests and `main`.
- Selection-anchor chips that end inside code are placed after it: after inline code, in a row below a code block.

**Done when:** the agent edits files and runs commands without prompts, and CI passes on the PR.

---

# Roadmap 2

M1–M5 built the design in `SPEC.md`. These milestones add settings, make Gloss a daily driver, let you queue and steer, take threads further, add search and code review sessions, converge on a long-term interface, add a second agent, and ship it; then future work (sub-agent threads, visual feedback, agent questions and permission modes). Same rules: in order, one PR each, stop for review. Where a milestone changes the design, update `SPEC.md` in the same PR.

## M6 — Settings
A home for Gloss's settings, editable by hand (and by agents) as well as in the app.

- **One `settings.json`** in Gloss's data folder (never in a project): global settings at the top level, per-project settings under `projects`, keyed by folder path.
- **A JSON Schema** next to it, so editors autocomplete and validate it and an agent can read what is allowed.
- **Live reload:** the main process watches the file and applies changes without a restart. Invalid JSON or values keep the last good settings and show what is wrong; nothing is reset or overwritten.
- **Settings screen** (from the sidebar, or `Ctrl+,`): global and current-project sections, the file's path, and "Open in editor". Saving from the screen writes the file, keeping unknown keys.
- Validated and owned by the main process; the renderer reads and writes through the IPC API.
- Move the dev model (Haiku) toggle into it.
- Later milestones add their own sections (M7: default model, status line items; M12: theme, transparency; M13: default agent, MCP servers; M14: updates). No section appears before its feature exists.

**Done when:** a setting changed in the screen shows up in the file, a change made in an editor (or by an agent) shows up in the app without a restart, and a broken edit is reported without losing the previous settings.

## M7 — Daily driver
- **Session management:** rename and delete sessions. Deleting removes the session, its messages, tool calls and threads from the DB, and deletes the agent's own copy (`session/delete` when the agent advertises it; Claude Code keeps transcripts under `~/.claude/projects`).
- **Projects and existing sessions:** sessions are grouped by folder (a project). Opening a project lists the agent's existing sessions for that folder (`session/list` with `cwd`, when advertised) alongside Gloss's own. Opening one Gloss hasn't seen imports it: a Gloss session is created for it and its display state is built from the `session/load` replay (user and agent messages, tool calls), all in the main thread. Sidebar layout needs a design pass.
- **Tool-call details:** a tool row expands to show what the agent did: the command and its output, a file edit as a diff, other content as text. Collapsed by default.
- **Code blocks:** syntax highlighting and a copy button. Highlighter: Shiki with its JavaScript regex engine (no WebAssembly, so the CSP stays as is), common languages preloaded and others loaded on demand; fall back to highlight.js via lowlight if Shiki's async loading fights streaming. Highlight tokens must carry source offsets so selection anchors in code keep working.
- **Model picker:** per session, from the agent's `configOptions` with category `model`, set via `session/set_config_option`. The dev toggle (Haiku) still overrides it while on.
- **Slash commands:** the composer autocompletes the agent's `available_commands_update` list after `/`.
- **Attachments:** paste or drop images; attach files as embedded context. Only what the agent's `promptCapabilities` allow.
- **Keyboard shortcuts:** new session, next/previous session, focus composer, close panel.
- **Notifications:** an OS notification (and taskbar badge) when a turn ends or fails while Gloss is not focused. Clicking it opens the session (and thread).
- **Export:** copy or save a thread or a whole session as markdown, for pasting into a PR description, chat or a doc.
- **Status line** at the bottom of the conversation, for the open session:
  - context usage (a meter and percentage, from the agent's `usage_update` used/size)
  - session cost (from `usage_update`)
  - model (from the model config option; clicking it opens the model picker)
  - permission mode: "bypass", or a warning when the agent refused bypass and Gloss is auto-approving
  - git branch of the session folder, with a dirty marker (the main process runs `git`; hidden outside a repo)
  - the session folder (moved here from the header)
  - turn state, e.g. "Working in item 2" (moved here from the header; click to open that thread)

  Agent-agnostic: everything but the git branch comes from ACP. Not Claude Code's configurable `statusLine` command.
- **Agent extensions:** the agent already loads its own plugins, skills and MCP servers (the Claude adapter reads user, project and local settings). Make them visible: their slash commands appear in the autocomplete, and a session view lists what the agent loaded, including MCP server status where the agent reports it (Claude Code answers `/mcp`). Gloss does not install or configure them.

**Done when:** you can use Gloss for a day of real work without reaching for the terminal: open a project and pick up a session you started in the `claude` CLI, clean up and rename sessions, see what a command printed or what an edit changed, switch models, see when context is filling up and run `/compact`, and paste a screenshot.

## M8 — Queue and steer
Stop waiting for a turn to end before you can say something.

- **Queue:** while a turn runs, the composer stays usable; a message sent then is queued (shown as pending, editable and removable) and sent when the turn ends, in order. Handled by Gloss, so it works with any agent. A queued message keeps its thread: it runs in the thread it was written in. *Landed early, before M8 (SPEC → Composer → Queue).*
- **Steer:** inject a message into the running turn ("skip the tests", "use the existing helper") when the agent supports it. The Claude adapter advertises a `_session/steering` extension in `initialize`; verify its request shape first. Offered only when the agent advertises steering; otherwise only queueing is available.
- The running turn's thread, the queue and any steering are visible in the status line and thread panel.

**Done when:** you can line up follow-ups while the agent works and they run in order in the right threads, and with Claude Code you can redirect a running turn without cancelling it.

## M9 — Threads, further
- **Threads overview:** a per-session list of all threads (anchor quote, reply count, last activity, running indicator). Clicking one opens it in the panel. Placement needs a design pass before M9 starts.
- **Agent plan:** `plan` updates render as a checklist (pending / in progress / done) in the thread whose turn produced them, updated in place as the agent works. Persisted, so it survives a restart.

**Done when:** in a session with several threads, any thread can be found and opened from the overview, and an agent's plan is visible and updates live in the thread it belongs to.

## M10 — Search
Find anything you discussed: "where did we decide the cache key format?"

- Full-text search across sessions, threads, agent messages and tool-call output, using SQLite FTS5 (available in Electron's `node:sqlite`). Indexed as messages are stored; existing data indexed by a migration.
- Results show the session, the thread (or main) and a highlighted snippet; opening one jumps to the message, opening its thread if needed.
- Scope: current session, current project, or everything. Filter by agent message, your message, or tool output.
- A shortcut (`Ctrl+K` or `Ctrl+Shift+F`) opens search from anywhere.

**Done when:** a phrase from any past session or thread is found in under a second and opening the result lands on it.

## M11 — Review sessions
A session type for reviewing code: the main view is a diff of the staged changes, and threads hang off lines of it. To the agent it is still one linear session.

- **Start a review** from a project ("Review staged changes"). The session list shows review sessions distinctly.
- **Diff viewer:** file list plus hunks of `git diff --staged` (read by the main process), syntax highlighted with M7's highlighter, usable on large diffs.
- **Line anchors:** a new anchor kind for a line or line range of the diff (file, side, line range, and the lines' text). Hover a line for Reply; select lines to reply to a range. Threads open in the side panel as today.
- **Wire format:** thread messages are tagged with the location, e.g. `[re: src/orders.ts:42 "cache.invalidate(id)"]`. At the start, Gloss tells the agent what is under review.
- **General conversation:** a collapsible main thread beside the diff for the change as a whole.
- **Refresh:** when the staged diff changes, it is re-read and each thread's lines are re-found by their text (as M4 does for selections). Threads whose lines are gone are marked outdated.
- **Agent first pass** (phase 2): "Review" asks the agent for its findings in a structured form (file, line range, comment); Gloss opens one thread per finding at its lines.
- The threads overview (M9) doubles as the list of review comments.
- Update `SPEC.md` with the review session type and the line anchor.

**Done when:** you can stage changes, open a review, discuss individual lines and ranges in threads and the whole change in the general thread, ask the agent for a first pass that lands as line threads, and see threads survive a re-stage (or be marked outdated).

**Decide during development:** how the agent's own fixes appear. They change files, so they show up as unstaged changes: show unstaged changes alongside the staged diff (distinguished), or keep them out until staged.

## M12 — UX review
Converge on a clean, sleek, long-term interface now that every surface exists. Two phases, with a review stop between them.

**Phase 1: review and target design** (designer-led)
- Inventory every screen and state as screenshots: empty app, project and session list (including imported sessions), streaming turn, tool details, status line, queued and steering messages, thread panel (new, active, running), selection popover and markers, threads overview, plan, search, review sessions (diff viewer, line threads, general conversation), settings, sign-in, notifications, errors and notices.
- List what is inconsistent, cluttered or unclear.
- **Brand identity:** a logo and wordmark for Gloss, an app icon (with the sizes and formats Windows, macOS and Linux need), a brand color, typography, and the overall visual style (the "margin note" idea is a natural starting point).
- **Live up to the name:** the interface should feel glossy: a slightly translucent window with sheen and depth, not flat panels. Electron 44 offers native materials for this: `backgroundMaterial` (`mica`, `acrylic`) on Windows 11 and `vibrancy` on macOS; Linux gets a solid fallback. Text must stay readable (AA contrast over the material), and transparency is turned off when the OS asks for reduced transparency.
- Define a small design system: color, type scale, spacing, radii, elevation and motion tokens for light and dark, an icon set, and the core components (buttons, chips and badges, inputs, panels, list rows, popovers).
- Updated mocks in `docs/mocks/` for the target interface. These replace the M1-era mocks as the reference.

**Phase 2: implementation**
- Rebuild the styles on the tokens (no one-off values) and bring every screen in line with the approved mocks.
- **Dark mode**, following the system setting, built on the dark tokens. *A Theme setting (System, Light, Dark) and a provisional dark palette landed early; M12 replaces the palette with the designed dark tokens.*
- Accessibility: every action reachable by keyboard with visible focus, WCAG AA contrast in both themes, labels for icon-only controls, and reduced motion respected.
- Apply the brand: logo and wordmark in the app (sidebar, empty state, sign-in), the app icon on the window and taskbar, and icon files ready for the M14 installers.
- Polish: empty, loading and error states; window title.

**Done when:** Gloss has its logo, icon and visual style, every screen matches the approved mocks in light and dark, styles use the tokens throughout, and the accessibility checks pass.

## M13 — A second agent
- Add Codex to the agent table via its ACP adapter (`@zed-industries/codex-acp` at the time of writing; verify the package, entrypoint and Windows support first).
- **New session** lets you pick the agent. The session list and header show which agent a session uses.
- Everything agent-specific stays in its `AgentConfig` entry: sign-in, bypass mode, model options and threads must work with no code paths for one agent.
- **Gloss-managed MCP servers:** a per-project list of MCP servers in Gloss, passed to whichever agent a session uses via ACP's `mcpServers` in `session/new` and `session/load` (today Gloss sends an empty list), so Claude Code and Codex get the same tools without configuring each separately. Only transports the agent advertises in `mcpCapabilities`.

**Done when:** a session with the second agent works end to end, including sign-in, threads and resume (or the lost-context notice if it can't resume).

## M14 — Shipping
- **Installers** with electron-builder: Windows (NSIS) first; macOS and Linux targets configured but best effort. The adapter's native CLI is unpacked from the app archive so it can run.
- **Release workflow:** pushing a version tag builds the installers in CI and publishes a GitHub Release.
- **Auto-update** from GitHub Releases (electron-updater), with an in-app "update ready, restart" prompt.
- README: how to install, and how to cut a release.
- Installers ship unsigned for now (Windows SmartScreen will warn: "More info → Run anyway").

**Done when:** a fresh Windows machine can install Gloss from a GitHub Release, sign in and run a session, and a later release updates it in place.

## M15 — Sub-agent threads (future)
An opt-in alternative to view-only threads: a thread runs its own agent session instead of being tagged into the main one. Changes the core idea in `SPEC.md` (update it in this milestone).

- **Thread mode setting** (M6 settings, global with a per-project override): `view-only` (default, today's behavior), `fresh` or `fork`.
  - **fresh:** a new agent session that starts with only the anchor text (plus the user's message). Cheap.
  - **fork:** `session/fork` of the main session at the moment the thread is created, so the sub-agent has the full context. Costs about as much as the main session.
  Both exist so they can be compared in practice. Each thread shows its mode.
- Each sub-agent thread has its own ACP session (stored on the Thread), resumed like any session. Turns in different sessions can run at the same time; Send is disabled per session, not everywhere. No file locking: as with several CLI sessions side by side, the user keeps their edits apart.
- **Resolve:** a sub-agent thread can be resolved. The sub-agent is asked for a compact summary of its conclusions, which is sent to the main session (shown in the main thread as the thread's result). A resolved thread is marked as such.
- **Cost is visible:** each sub-agent thread's context and cost appear in the status line when it is open, and in the threads overview.
- If the mode is `fork` and the agent does not advertise `session/fork` (it is optional in ACP), creating the thread fails with a visible error. No silent fallback.

**Done when:** with either mode on, a thread runs as its own agent, can run while the main thread works, and resolving it brings its summary into the main session.

## M16 — Visual feedback (experimental, future)
Point at things visually to give the agent feedback. Expect to iterate on this continuously based on use; the first version is deliberately small.

**First version: capture, then annotate**
- A palette (shortcut, or from the composer) captures a region, a window or the screen (Electron `desktopCapturer`), then opens it in a Gloss annotation canvas.
- Tools: numbered **pins** with a short note each, pen, highlighter, box, arrow; undo.
- Sent to the agent as the flattened image plus a numbered text list of the pins and notes ("1: …", "2: …"). Numbered marks follow Set-of-Mark prompting: models refer to labeled marks far more reliably than to free-form circles.
- **Pins are anchors:** each pin can be opened into a thread, like list items, selections and diff lines.
- Privacy: default to region or single-window capture, and always show exactly what will be sent before sending.
- Needs M7 attachments (the agent must accept images).

**Done when:** you can capture part of the screen, mark it up with pins and drawings, send it, get a response that refers to your marks, and discuss a single pin in its own thread.

**Possible directions** (to try based on use, not commitments)
- Live drawing over the screen (a transparent always-on-top overlay) instead of capture first.
- Voice narration while drawing, sent with a timeline aligning what was said with what was drawn.
- Element picking for web apps: select a DOM element in a running page and send its selector, styles and source location (stagewise / React Grab style), not just pixels.
- Annotating Gloss's own content (messages, diffs) as images.
- A blank canvas for sketching mockups and diagrams.
- Several images in one message: before and after, or a sequence of steps.
- Short screen recordings for interactions and animations.
- The agent annotates back: it returns a screenshot with its own numbered marks.
- Verify loop: after a fix, re-capture the same region and compare with the original.
- Automatic marks: segment the capture and number regions so you only pick the ones you mean.
- An MCP tool so the agent can ask you for a screenshot of something.

## M17: Questions and permission modes (future)
Let the agent ask the user things, and let the user choose how much it may do without asking. Replaces SPEC → Permissions ("no approval UI"); update it in this milestone.

- **Agent questions:** advertise ACP's `clientCapabilities.elicitation.form` and answer `elicitation/create` requests with a question dialog built from the request's JSON Schema: single and multiple choice, free text, and the agent's "other" answer where it allows one, plus Decline and Cancel. With form support the Claude adapter turns on Claude Code's AskUserQuestion tool (disabled today because Gloss doesn't advertise it) and sends its questions this way; MCP servers' elicitations arrive the same way. The question shows in the thread whose turn asked it. URL elicitations (open a link, wait for `session/complete_elicitation`) are optional.
- **Permission modes:** a per-session mode picker from the agent's `modes` (Claude Code: Manual, Accept edits, Plan, Auto, Bypass permissions), set with `session/set_mode` and kept in sync from `current_mode_update`. It replaces the status line's "bypass" item. A default mode in settings (global, with a per-project override) replaces always entering `bypassModeId`; bypass stays the default.
- **Approval prompts:** in a mode where the agent asks, `session/request_permission` shows an approval prompt (the tool call's title and what it will run or change, with the agent's options: allow once, allow always, reject) in the thread of the running turn, instead of being auto-approved. Auto-approval remains for agents without a bypass mode only if the user picks it.
- **Waiting on the user:** a turn waiting on a question or an approval is still running (queued messages wait), shows "Waiting for you" in the status line and sidebar, and sends an OS notification when Gloss isn't focused. Cancel answers it with `cancelled`.
- Agent-agnostic: everything comes from ACP modes, permission options and elicitation schemas. Verify first: the SDK's elicitation request and response shapes (`CreateElicitationRequest`/`CreateElicitationResponse`), and how the Claude adapter maps AskUserQuestion (several questions per request, multi-select, the custom answer).

**Done when:** Claude Code can ask a multiple-choice question mid-turn and gets the answer from a Gloss dialog, and a session switched to Manual asks before each edit or command and continues or stops based on the answer.

## Future work (after the milestones)
Ideas worth building once the milestones are done. Not scheduled; first item first.

1. **Checkpoints and undo per turn:** snapshot the working tree before each turn (in a hidden shadow repo or `git stash create`-style refs, not your history) to undo a turn's changes and see exactly what a turn changed. A safety net for bypass mode; pairs with review sessions ("review what turn 12 changed").
2. **Hover to explain:** hover a term, function or code span in an agent message for a short explanation from a throwaway sub-agent (M15's `fresh` mode), without spending main-session context or opening a thread.

## Design passes needed
- **M7:** sidebar with projects (folders) and their sessions, including the agent's existing sessions not yet opened in Gloss.
- **M9:** where the threads overview lives (a sidebar section under the session, or a header button that opens a list in the side panel).
- **M11:** the diff viewer layout, line Reply affordances and range selection, where the general conversation sits, and how agent-opened threads look.
- The M7–M11 passes are deliberately light: enough to build them. M12 revisits everything as a whole.
- **M15:** choosing a thread's mode, showing a sub-agent thread's state and cost, and the resolve flow (what the summary looks like in the main thread).
- **M16:** the palette, the annotation canvas and its tools, and how pins look in the image and as thread anchors.
- **M17:** the question dialog (inline in the thread or modal), the approval prompt, and the mode picker.

## Todo
- Learn about code signing (Windows Authenticode certificates, macOS signing and notarization) before sharing Gloss more widely.
- Review sessions on other bases: unstaged changes, the current branch vs. `main`, a commit range (M11 starts with staged changes; keep the line anchor base-agnostic).
