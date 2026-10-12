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
