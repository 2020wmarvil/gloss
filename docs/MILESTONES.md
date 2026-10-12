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

M1–M5 built the design in `SPEC.md`. These milestones make Gloss a daily driver, take threads further, converge on a long-term interface, add a second agent, and ship it. Same rules: in order, one PR each, stop for review. Where a milestone changes the design, update `SPEC.md` in the same PR.

## M6 — Daily driver
- **Session management:** rename and delete sessions. Deleting removes the session, its messages, tool calls and threads from the DB, and deletes the agent's own copy (`session/delete` when the agent advertises it; Claude Code keeps transcripts under `~/.claude/projects`).
- **Projects and existing sessions:** sessions are grouped by folder (a project). Opening a project lists the agent's existing sessions for that folder (`session/list` with `cwd`, when advertised) alongside Gloss's own. Opening one Gloss hasn't seen imports it: a Gloss session is created for it and its display state is built from the `session/load` replay (user and agent messages, tool calls), all in the main thread. Sidebar layout needs a design pass.
- **Tool-call details:** a tool row expands to show what the agent did: the command and its output, a file edit as a diff, other content as text. Collapsed by default.
- **Code blocks:** syntax highlighting and a copy button. Highlighter: Shiki with its JavaScript regex engine (no WebAssembly, so the CSP stays as is), common languages preloaded and others loaded on demand; fall back to highlight.js via lowlight if Shiki's async loading fights streaming. Highlight tokens must carry source offsets so selection anchors in code keep working.
- **Model picker:** per session, from the agent's `configOptions` with category `model`, set via `session/set_config_option`. The dev toggle (Haiku) still overrides it while on.
- **Slash commands:** the composer autocompletes the agent's `available_commands_update` list after `/`.
- **Attachments:** paste or drop images; attach files as embedded context. Only what the agent's `promptCapabilities` allow.
- **Keyboard shortcuts:** new session, next/previous session, focus composer, close panel.

**Done when:** you can use Gloss for a day of real work without reaching for the terminal: open a project and pick up a session you started in the `claude` CLI, clean up and rename sessions, see what a command printed or what an edit changed, switch models, run `/compact`, and paste a screenshot.

## M7 — Threads, further
- **Threads overview:** a per-session list of all threads (anchor quote, reply count, last activity, running indicator). Clicking one opens it in the panel. Placement needs a design pass before M7 starts.
- **Agent plan:** `plan` updates render as a checklist (pending / in progress / done) in the thread whose turn produced them, updated in place as the agent works. Persisted, so it survives a restart.

**Done when:** in a session with several threads, any thread can be found and opened from the overview, and an agent's plan is visible and updates live in the thread it belongs to.

## M8 — UX review
Converge on a clean, sleek, long-term interface now that every surface exists. Two phases, with a review stop between them.

**Phase 1: review and target design** (designer-led)
- Inventory every screen and state as screenshots: empty app, project and session list, streaming turn, tool details, thread panel (new, active, running), selection popover and markers, threads overview, plan, sign-in, errors and notices, light and dark.
- List what is inconsistent, cluttered or unclear.
- **Brand identity:** a logo and wordmark for Gloss, an app icon (with the sizes and formats Windows, macOS and Linux need), a brand color, typography, and the overall visual style (the "margin note" idea is a natural starting point).
- Define a small design system: color, type scale, spacing, radii, elevation and motion tokens for light and dark, an icon set, and the core components (buttons, chips and badges, inputs, panels, list rows, popovers).
- Updated mocks in `docs/mocks/` for the target interface. These replace the M1-era mocks as the reference.

**Phase 2: implementation**
- Rebuild the styles on the tokens (no one-off values) and bring every screen in line with the approved mocks.
- **Dark mode**, following the system setting, built on the dark tokens.
- Accessibility: every action reachable by keyboard with visible focus, WCAG AA contrast in both themes, labels for icon-only controls, and reduced motion respected.
- Apply the brand: logo and wordmark in the app (sidebar, empty state, sign-in), the app icon on the window and taskbar, and icon files ready for the M10 installers.
- Polish: empty, loading and error states; window title.

**Done when:** Gloss has its logo, icon and visual style, every screen matches the approved mocks in light and dark, styles use the tokens throughout, and the accessibility checks pass.

## M9 — A second agent
- Add Codex to the agent table via its ACP adapter (`@zed-industries/codex-acp` at the time of writing; verify the package, entrypoint and Windows support first).
- **New session** lets you pick the agent. The session list and header show which agent a session uses.
- Everything agent-specific stays in its `AgentConfig` entry: sign-in, bypass mode, model options and threads must work with no code paths for one agent.

**Done when:** a session with the second agent works end to end, including sign-in, threads and resume (or the lost-context notice if it can't resume).

## M10 — Shipping
- **Installers** with electron-builder: Windows (NSIS) first; macOS and Linux targets configured but best effort. The adapter's native CLI is unpacked from the app archive so it can run.
- **Release workflow:** pushing a version tag builds the installers in CI and publishes a GitHub Release.
- **Auto-update** from GitHub Releases (electron-updater), with an in-app "update ready, restart" prompt.
- README: how to install, and how to cut a release.
- Installers ship unsigned for now (Windows SmartScreen will warn: "More info → Run anyway").

**Done when:** a fresh Windows machine can install Gloss from a GitHub Release, sign in and run a session, and a later release updates it in place.

## Design passes needed
- **M6:** sidebar with projects (folders) and their sessions, including the agent's existing sessions not yet opened in Gloss.
- **M7:** where the threads overview lives (a sidebar section under the session, or a header button that opens a list in the side panel).
- These are deliberately light: enough to build M6 and M7. M8 revisits everything as a whole.

## Todo
- Learn about code signing (Windows Authenticode certificates, macOS signing and notarization) before sharing Gloss more widely.
