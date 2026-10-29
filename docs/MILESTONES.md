# Milestones

Build in order, from M19 through M23 (Marketing). Stop at the end of each milestone, show what works and how to try it, and wait for review before starting the next.

M1 through M18, failed-turn actions and worktrees are done. Next is shared skills and plugins, followed by sub-agent threads and performance improvements before shipping, then marketing. Same rules: follow the listed order, one PR each, stop for review. Where a milestone changes the design, update `SPEC.md` in the same PR.

## M19: Shared plugin library and marketplaces
Build on M13's global MCP settings and M14's agent profiles. Plugins are the top-level library entries; skills, tools and other capabilities are components inside them. Implement the three phases below in order, and stop for review at the end of each phase. Design and update `SPEC.md` for the phase being implemented; later phases do not block completion of the current one.

**Skill compatibility groundwork (Windows, 2026-10-26):** tested Claude ACP 0.89.1 with its bundled Claude 2.1.293, Codex ACP 2.2.2 with CLI 0.160.1, and OpenCode 2.0.32 against a local mock provider. All discovered junction and copied skill deployments. Claude required a new session for edits to the junction target; Codex loaded edited instructions but needed a restart for its command description; OpenCode loaded edited skills and supporting files. OpenCode also discovered Claude/shared skill roots, so removing its own link did not disable a skill; a native per-skill deny rule hid it and rejected loading. A custom OpenCode profile loaded a configured skill directory. Codex's supporting-file tool check was unverified because the mock did not implement its automatic-review response format. These checks validate skill delivery, not whole-plugin portability. Plugin packaging/lifecycle, other platforms and production transfer/recovery behavior remain to be verified.

**Design reference:** the local [plugin-library mock](mocks/plugins.html) now covers phase 1 only: custom plugin creation, nested skill editing, connections, agent availability and removal. The library has no Discover tab or import/manage-existing entry points. Agent controls live in the plugin's Agents detail tab, without a duplicate matrix in the library list. All example data and actions are simulated; component support still needs native verification.

### ~~Phase 1: Custom plugins~~
Create and maintain your own plugins in Gloss, and make them available to compatible configured agents.

- **Personal plugin library:** users or agents can create a plugin containing one skill or several related skills, supporting scripts/references and supported MCP connections. Store it in persistent user data outside the app installation and automatic agent discovery roots. No publishing, marketplace, upstream provenance, version management or update subscription is required.
- **Create and edit:** provide a searchable plugin list, plugin details, nested skill editing and supporting-file inspection. Allow adding related skills and supported tool connections to a plugin. Ordinary files remain editable by the user or an agent; edits have one authoritative version.
- **Agent availability:** enable a plugin as a unit for selected compatible agents, including Claude Code, Codex, OpenCode and custom ACP profiles. In the Agents tab, show component-level full/partial support, required setup and effective availability. Account for inherited discovery through other agent roots. Custom profiles may configure skill directories, but that establishes only skill-component support. Distinguish tested, user-configured, unsupported and unknown support.
- **Package format and delivery:** verify installed native plugin formats and loading mechanisms before choosing the library representation and adapters. Use native plugin loading where supported, or explicit mappings for portable skills and MCP components with limitations shown. Validate links/junctions and any tracked-copy fallback. Hooks and other agent-specific components are available only where verified; do not imply that copying instructions makes an entire plugin portable.
- **Connections and removal:** integrate plugin connections with M13's global MCP configuration and track their uses. Disabling a plugin for one agent preserves the library item and other deployments. Removing a plugin preserves pre-existing or independently used connections and components. Phase 1 operates on new Gloss-created plugins and their deployments; it does not take ownership of existing native plugins or skill folders.
- **Manual edits and refresh:** make edited instructions and supporting files available to enabled agents. Explain which existing sessions need a new session or connection refresh. Finish active turns before restarting connections. Detect deployment divergence or failure without silently overwriting edits.
- **Verify:** exercise a new one-skill plugin and a plugin with related skills plus an MCP dependency. Cover creation, editing, component requirements, enable/disable, refresh, removal and persistence across restart on known agents and one concrete custom profile. Verify naming conflicts and that existing native installations are not overwritten.

**Done when:** a user can create a custom plugin, edit its skills and supporting files, attach a supported connection, enable it for compatible configured agents and use the resulting workflow. Changes are shared after any required refresh, support limits are clear, and the plugin and deployment state survive restart. Disabling or removing it preserves unrelated installations and shared connections. Import and marketplace features are not required.

**Done.** See SPEC → Plugins. Verified with real adapters (Claude ACP 0.89, Codex ACP 2.2.2, OpenCode 2.0.32 and a custom OpenCode profile) against a local model stub and MCP server (`src/main/plugins.integration.test.ts`, opt in with `GLOSS_PLUGIN_NATIVE=1`): each loaded a plugin's skill and its supporting file, saw the shared MCP tool, picked up an edited skill after a restart and resume, and dropped the skill but kept the tool once disabled. Codex's supporting-file read wasn't checked (its automatic reviewer needs a structured answer the stub doesn't give). Live through the built app on Haiku 5.5, a Claude session loaded `gloss-release-notes:release-notes-instructions` and quoted its edited steps. The built app with a fresh data folder covered creation, editing, files, connections, enabling, custom setup and removal, and kept all of it across a restart.

### Phase 2: Plugin import
Bring in content the user has already selected, such as a local plugin, standalone skill, known repository or existing agent installation.

- **Design ownership first:** revisit what import means for source files and native managers before implementation. Moving existing skills into Gloss and replacing them with links is not an accepted default. The source ownership, registration and transfer decisions discussed earlier are deferred to this phase.
- **Preview the complete package:** inspect skills, supporting files, tools, hooks and dependencies, resolve naming conflicts, and show what each selected agent can use. A standalone skill can become a simple personal plugin. Keep related components together; any intentional partial import must explain the missing functionality.
- **Review affected locations:** show exactly what will be registered, created or changed and which manager owns each installation. Preserve source content on failure, and leave native plugin caches with their manager unless a supported transfer is explicitly chosen. Importing content does not itself execute its scripts or unsupported hooks.
- **Use the phase 1 lifecycle:** imported content uses the same library, editing, compatibility, deployment and removal flows. Account for required tools and preserve independently used connections. There is no separate independent-copy mode or ongoing upstream synchronization requirement.
- **Verify:** test imports from each supported source type, name collisions, dependencies, unsupported components, failed operations, restart recovery and preservation of source files and existing installations according to the reviewed ownership model.

**Done when:** a user can review and import a selected plugin or standalone skill, understand its ownership and any file changes, and use it through the phase 1 library. Failures preserve existing content, component relationships remain visible, and imports persist across restart. Browsing or searching marketplaces is not required.

### Phase 3: Plugin discovery
Find new plugins from supported catalogs and install them through the established review and library flows.

- **Browse and search:** verify catalog APIs, select initial supported sources and offer add-source support where available. Show publisher, source, description, version, components and agent requirements. Identify unsupported sources and unavailable results clearly.
- **Review and install:** feed a selected result into the package preview. Show dependencies, requested access, ownership and installation destinations. Install through supported agent mechanisms, reporting progress, authentication/setup needs, failures and refresh requirements.
- **Installation records and removal:** track source/version and ownership where needed for native installation and removal. Preserve pre-existing installations and components used independently or by another plugin.
- **Verify:** exercise search, package inspection, installation, required setup, failure handling, restart and removal against the supported catalogs and agent mechanisms.

**Done when:** a user can find a plugin in a supported catalog, review what it contains and which agents can use it, install it, complete any required setup and remove it without disrupting other plugins or existing installations.

**Outside M19:** package-manager-style upstream updates remain a separate exploratory milestone. Presets, separate workspace dashboards and multi-device library backup are also deferred.

## M20: Sub-agent threads
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

## M21: Performance
Measure first, then fix what the numbers show. Keep the app's behavior unchanged, and don't optimize anything the measurements don't point at.

- **Latency needs attention:** application startup until the UI is responsive, starting and opening sessions, and opening, navigating and scrolling large diffs in the diff viewer. Measure these paths and reduce the delays.

- **Benchmarks you can rerun:** a script that seeds a scratch user data folder (`--user-data-dir`) with large sessions (hundreds of turns, long code-heavy answers, many tool calls and diffs, dozens of threads, and many large screenshot/image attachments with mixed aspect ratios and pin notes) and drives the built app over CDP. It records: cold start to first paint and to an interactive sidebar, opening a large session, the frame time and main-process CPU while a fake agent streams a long answer at realistic chunk rates, switching sessions, opening a thread, search latency, typing latency and scroll frame times while streaming in an image-heavy session, and memory after an hour of use (including image decoding and retained offscreen images). Results go to a JSON file so a later run can be compared.
- **Profile the hot paths:** the renderer with the Chrome DevTools Performance panel and React Profiler (which components render per streamed chunk, and why), the main process with `--inspect` and a CPU profile, and the database with timings of the statements run per chunk (including the full-text triggers). Count IPC messages and bytes per turn. Measure layout and paint costs from scroll-height reads, automatic bottom scrolling, resize observers and image-load handlers; check whether streamed chunks force layout of the entire conversation.
- **Fix the confirmed hotspots,** each with its before and after numbers in the PR. Likely candidates to check: re-rendering and re-parsing every message's markdown on each chunk, rewriting a message's full text (and its search index) on each chunk, sending the full text over IPC on each chunk, and rendering long logs and large diffs in full, repeated scroll-height/layout work, and retaining or reprocessing offscreen images. Include a reproducible regression case matching a long coding session with repeated screenshot feedback, tool output and active streaming. Choices like batching chunks or virtualizing the log are made here from the measurements, and recorded in `SPEC.md` where they change the design.
- **Startup and size:** what loads before the first window (bundle size, Shiki grammars, adapter launch, the session list) and what can wait.
- **Regression tests, in two tiers:**
  - *Deterministic, in `npm test`:* assert counts, not times, so they don't flake. Streaming a chunk re-renders only the message it changed (React Profiler `onRender` counts). Database writes and IPC bytes per chunk stay bounded rather than growing with the message length (`SessionManager` against the fake agent, with an instrumented store and emit). Opening a large seeded session issues a bounded number of queries. The renderer bundle and the main bundle stay under a size budget.
  - *Timed, run on demand (`npm run bench`), not in CI by default:* the benchmark compares itself against a checked-in baseline and fails past a generous margin (for example 25% slower, or any renderer long task over 50 ms while streaming). Shared CI runners are too noisy for wall-clock budgets, so the baseline is per machine, and updating it is an explicit step.
- Add the benchmark and the regression tests to the docs, with how to run them and how to update the baseline.

**Done when:** the benchmark runs from one command, each fixed hotspot shows a measured improvement and has a deterministic test that would catch it coming back, typing and scrolling while streaming a long answer into a large, image-heavy session stay smooth (no long tasks over 50 ms in the renderer), and the numbers are recorded for the next comparison.

## M22: Shipping
- **Installers** with electron-builder: Windows (NSIS) first; macOS and Linux targets configured but best effort. The adapter's native CLI is unpacked from the app archive so it can run.
- **Release workflow:** pushing a version tag builds the installers in CI and publishes a GitHub Release.
- **Auto-update** from GitHub Releases (electron-updater), with an in-app "update ready, restart" prompt.
- README: how to install, and how to cut a release.
- **Code signing:** investigate Windows Authenticode certificates and macOS signing and notarization before wider distribution. Decide and document the release signing policy, configure signing in CI where adopted, and document any unsigned targets and their installation warnings.

**Done when:** a fresh Windows machine can install Gloss from a GitHub Release, sign in and run a session, and a later release updates it in place. The signing policy is documented, and release artifacts follow it.

## M23: Marketing
Present Gloss to people who haven't used it. Comes after Shipping, so every link points at a release people can install.

- **README:** lead with what Gloss is and why threads help, with visuals near the top: screenshots in light and dark, and short GIFs of the core features (replying to an item in a thread, steering a running turn, visual feedback pins). Install from the latest GitHub Release first; building from source moves lower. Trim the feature walkthrough to the highlights and link to the docs for the rest.
- **Docs cleanup:** separate user-facing docs (setup, agents, OpenCode and local models, custom ACP profiles) from design and development notes (`SPEC.md`, `MILESTONES.md`, mocks, UX review). Remove stale status notes, check every link and command, and make sure each user doc says which agents and platforms it covers.
- **Motion graphics demo reel:** a short video (about a minute) that shows the problem (a long linear session) and Gloss's answer (threads), then the other headline features. Uses the brand from `docs/BRAND.md`. Kept as source alongside its exported video, so it can be updated after UI changes.
- **Repository presentation:** GitHub description, topics and a social preview image, so links to the repository look right when shared.
- Capture visuals from the built app with a scratch data folder and demo projects, never from real sessions, and with Haiku as the model.

**Done when:** someone landing on the repository understands what Gloss does from the README's first screen, can install it from the release link, find the docs for their agent, and watch the demo reel.

## Exploratory milestone: Package-manager-style skill updates
Unscheduled exploration outside the M19-M23 delivery sequence. Revisit only if maintaining externally sourced skills becomes a useful workflow; M19's manually maintained shared library does not depend on it.

- Investigate optional source and version tracking for skills that have an upstream repository or package. User-authored skills and skills with unknown origins must continue to work without this metadata.
- Explore explicit update checks and previews, version pinning, recovery, and handling local edits when upstream files change. Evaluate whether automatic updates are useful as a separate opt-in decision.
- Distinguish upstream updates from making manual library edits available to agents, which belongs in M19.

**Done when:** the exploration records concrete use cases, evaluates existing tooling, and recommends whether to proceed, with a proposed scope and update/conflict flow if warranted. Implementing an updater is not required to complete this exploration.

## Design passes needed
- ~~**M14:** agent profiles and connection testing, guided open source/local-model setup, capability indicators, and actionable launch or model-server errors.~~ Done.
- ~~**M15:** the question dialog (inline in the thread or modal), the approval prompt, and the mode picker.~~ Done.
- ~~**M16:** the palette, the annotation canvas and its tools, and how pins look in the image and as thread anchors.~~ Done: `docs/mocks/visual-feedback.html`.
- ~~**M18:** the phone layout (session list, conversation, threads full screen, composer with queue and steer), pairing and the devices list.~~ Done: `docs/mocks/mobile.html`.
- ~~**Worktrees:** the New session menu, the Worktrees screen, removal, and setup in progress or failed.~~ Done: `docs/mocks/worktrees.html`.
- **M19:** ~~phase 1, custom plugin library, nested skill editing, connections, Agents-tab availability and refresh~~ (done); phase 2, source ownership and import previews; phase 3, catalog browsing/search and installation previews. Review each phase separately.
- **M20:** choosing a thread's mode, showing a sub-agent thread's state and cost, and the resolve flow (what the summary looks like in the main thread).

---

# Done

Finished milestones, oldest first.

## ~~M1 — ACP spike~~
- Electron + electron-vite + TypeScript scaffold, secure defaults (see SPEC → Stack → Security).
- Main process spawns the Claude Code ACP adapter, runs `initialize` and `session/new`, sends one hard-coded prompt, and logs `session/update` notifications and the final `stopReason`.
- Dev toggle that sets `ANTHROPIC_MODEL=haiku` on the spawned process.
- Log the agent's advertised capabilities (especially `loadSession`).

**Done when:** `npm run dev` opens a window and a prompt round-trips through the adapter with streamed output visible (console or a bare page is fine).

## ~~M2 — Linear chat~~
- Renderer: session list, one conversation view, composer.
- Streamed agent text rendered as sanitized markdown; tool calls shown as compact rows (title + status).
- SQLite persistence for sessions, messages, tool calls. Reopening the app shows past sessions.
- Send disabled while a turn runs; Cancel button that sends `session/cancel`.
- Resume via `session/load` when supported; otherwise a clear "new agent session" notice.
- Agent-agnostic sign-in from ACP `authMethods` when a request fails with `auth_required` (see SPEC → Authentication).

**Done when:** a normal multi-turn session with Claude Code works end to end and survives an app restart (display at minimum), and an expired login can be fixed from inside the app.

## ~~M3 — List-item threads (the core feature)~~
- Top-level list items in agent messages get a hover "Reply" button; items with a thread show a reply-count badge.
- Thread side panel: anchor quote, thread messages, composer.
- Wire tag `[re: "…"]` on send; routing of the reply (text and tool calls) to `currentThread`.
- `threadId` persisted; main view hides thread messages.
- Indicator showing which thread a running turn belongs to.

**Done when:** you can ask for a review, open threads on two different items, have a back-and-forth in each, and the main view stays short.

## ~~M4 — Selection anchors~~
- Map a DOM selection inside an agent message to source-markdown offsets.
- "Reply to selection" popover (also keyboard: `R`).
- Inline marker for existing selection anchors (dotted underline + count chip) that opens the thread.
- Re-find anchors by stored text if offsets don't match after re-render.

**Done when:** threads can be started from arbitrary prose or code spans and reopened from their inline markers.

## ~~M5 — Misc~~
- Drop permission prompts (SPEC → Permissions): switch sessions to the agent's bypass mode when it has one, and auto-approve permission requests.
- CI: GitHub Actions running typecheck, lint, tests and the build on Windows and Linux for pull requests and `main`.
- Selection-anchor chips that end inside code are placed after it: after inline code, in a row below a code block.

**Done when:** the agent edits files and runs commands without prompts, and CI passes on the PR.

## ~~M6 — Settings~~
A home for Gloss's settings, editable by hand (and by agents) as well as in the app.

- **One `settings.json`** in Gloss's data folder (never in a project): global settings at the top level, per-project settings under `projects`, keyed by folder path.
- **A JSON Schema** next to it, so editors autocomplete and validate it and an agent can read what is allowed.
- **Live reload:** the main process watches the file and applies changes without a restart. Invalid JSON or values keep the last good settings and show what is wrong; nothing is reset or overwritten.
- **Settings screen** (from the sidebar, or `Ctrl+,`): global and current-project sections, the file's path, and "Open in editor". Saving from the screen writes the file, keeping unknown keys.
- Validated and owned by the main process; the renderer reads and writes through the IPC API.
- Move the dev model (Haiku) toggle into it.
- Later milestones add their own sections (M7: default model, status line items; M12: theme; M13: default agent, MCP servers; M22: updates). No section appears before its feature exists.

**Done when:** a setting changed in the screen shows up in the file, a change made in an editor (or by an agent) shows up in the app without a restart, and a broken edit is reported without losing the previous settings.

## ~~M7 — Daily driver~~
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

## ~~M8 — Queue and steer~~
Stop waiting for a turn to end before you can say something.

- **Queue:** while a turn runs, the composer stays usable; a message sent then is queued (shown as pending, editable and removable) and sent when the turn ends, in order. Handled by Gloss, so it works with any agent. A queued message keeps its thread: it runs in the thread it was written in. *Landed early, before M8 (SPEC → Composer → Queue).*
- **Steer:** inject a message into the running turn ("skip the tests", "use the existing helper") when the agent supports it. The Claude adapter advertises a `_session/steering` extension in `initialize`; verify its request shape first. Offered only when the agent advertises steering; otherwise only queueing is available.
- The running turn's thread, the queue and any steering are visible in the status line and thread panel.

**Done when:** you can line up follow-ups while the agent works and they run in order in the right threads, and with Claude Code you can redirect a running turn without cancelling it.

## ~~M9 — Threads, further~~
- **Threads overview:** a per-session list of all threads (anchor quote, reply count, last activity, running indicator). Clicking one opens it in the panel. Placement: a collapsible right-hand side panel that shows the overview or one thread (SPEC → Conversation view → Side panel).
- **Agent plan:** `plan` updates render as a checklist (pending / in progress / done) in the thread whose turn produced them, updated in place as the agent works. Persisted, so it survives a restart.
- **Back to main on the wire:** the first main-thread message after a thread is tagged `[re: the main conversation, not the thread above]`, so the agent doesn't read it as continuing the thread (SPEC → Wire format).

**Done when:** in a session with several threads, any thread can be found and opened from the overview, and an agent's plan is visible and updates live in the thread it belongs to.

## ~~Shared sessions (pulled ahead of M10)~~
Make the agent's session the source of truth, so one session can be continued in Gloss and in the `claude` CLI (SPEC → Shared sessions). Replaces import-once and the "Not in Gloss yet" section.

- **Sync:** every `session/load` replay is matched against the cached log, keeping matched entries (and their threads), adding new ones and removing ones the agent no longer has. Messages from elsewhere are placed in threads by their tag; text-file attachments are parsed back from the replay.
- **Reload on change:** compare `session/list` `updatedAt` with `syncedAt` on open, window focus and before each send; `session/close` then `session/load` when it moved. Never during a turn.
- **One session list** in the sidebar: Gloss's sessions and the agent's own, by recent activity. Titles come from the agent unless renamed in Gloss.
- **Deleted outside Gloss:** a session the agent no longer has (`resource_not_found` on load) is deleted in Gloss too, instead of silently getting a new agent session. Sessions that never had a message are exempt.
- **Existing data:** current sessions sync like any other on their next resume; matching keeps their message ids, so their threads carry over. Back up the DB before the first run on real data.
- Verify first: where a steered message lands in the transcript and the replay, and that a separate data folder (`--user-data-dir`) works, so development never runs against the live DB. Extend `sessions.test.ts`: a fake agent whose history changes between loads.

**Done when:** a session started in Gloss with threads can be continued with `claude --resume`, and back in Gloss the CLI turns show in the main thread, the threads are intact, and the agent remembers both.

## ~~M10 — Search~~

Implemented for review: FTS5 indexes and migration, scoped search dialog, safe highlighted excerpts, message/thread/tool navigation, and `Ctrl+Shift+F`. Searches history loaded into Gloss.

Find anything you discussed: "where did we decide the cache key format?"

- Full-text search across sessions, threads, agent messages and tool-call output, using SQLite FTS5 (available in Electron's `node:sqlite`). Indexed as messages are stored; existing data indexed by a migration.
- Results show the session, the thread (or main) and a highlighted snippet; opening one jumps to the message, opening its thread if needed.
- Scope: current session, current project, or everything. Filter by agent message, your message, or tool output.
- A shortcut (`Ctrl+K` or `Ctrl+Shift+F`) opens search from anywhere.

**Done when:** a phrase from any past session or thread is found in under a second and opening the result lands on it.

## ~~M11 — Review sessions~~
A session type for checking an agent's work: the main view is the branch's diff, threads hang off its lines, and the agent reviews first. To the agent it is still one linear session, separate from the one that wrote the code. Designed in a mock since replaced by `docs/mocks/target.html#review`, and specified in `SPEC.md` (Review sessions).

- **Start a review** from a project ("Review changes"). The session list shows review sessions distinctly, with their open thread count.
- **What is reviewed:** from a base (by default the merge base with the pull request's base, else the default branch) to the working tree (committed or not, plus untracked files) or a commit, both picked in dropdowns; read by the main process and refreshed as the agent works.
- **Diff viewer:** stacked files with sticky, collapsible headers, a collapsible file tree, split (default, lines scroll sideways per side) or unified, syntax highlighted, usable on large diffs.
- **Line anchors** from a code selection, sent as `[re: path:line "…"]`.
- **Comment cards** inline under their lines, collapsible to a gutter marker, with a global show/hide toggle.
- **Agent first pass** on start: findings in a structured block, each opened as a line thread with its severity.
- **Fixes** by the review agent itself, in the thread; the diff updates.
- **Outdated** threads when their lines change, **Resolve** by the user.
- **Side panel:** the general conversation pinned at the top of the threads overview, threads grouped by file with Open/Resolved and severity filters; `N`/`P` move between open threads.

Build in two PRs: the diff viewer with line threads and the general conversation, then the first pass, outdated threads and resolve.

**Done when:** "Review changes" opens a review whose agent first pass lands as line threads, you can discuss lines in threads and the whole change in the general conversation, the agent's fixes appear in the diff, and threads follow their lines or are marked outdated.

## ~~M12 — UX review~~
Converge on a clean, sleek, long-term interface now that every surface exists. Two phases, with a review stop between them.

**Phase 1: review and target design** (designer-led)
- Inventory every screen and state as screenshots: empty app, project and session list (including imported sessions), streaming turn, tool details, status line, queued and steering messages, thread panel (new, active, running), selection popover and markers, threads overview, plan, search, review sessions (diff viewer, line threads, general conversation), settings, sign-in, notifications, errors and notices.
- List what is inconsistent, cluttered or unclear.
  *Done. The original inventory and screenshots are preserved in Git history; the approved design is in `docs/mocks/target.html` and `docs/mocks/design-system.html`.*
- **Brand identity:** a logo and wordmark for Gloss, an app icon (with the sizes and formats Windows, macOS and Linux need), a brand color, typography, and the overall visual style (the "margin note" idea is a natural starting point). *Done: a glossy bead in a Sunset gradient, lowercase `gloss` wordmark; see `docs/BRAND.md`.*
- **Live up to the name:** the interface should feel glossy, with sheen and depth, not flat panels. The window stays opaque: sheen and depth come from the styles (light catching the top edges of panes, layered elevation), defined in the target mocks. *A translucent window (Electron's `backgroundMaterial` Mica and Acrylic on Windows 11) was tried in a live demo and rejected: Mica was too faint to notice and Acrylic looked muddy over other windows.*
- Define a small design system: color, type scale, spacing, radii, elevation and motion tokens for light and dark, an icon set, and the core components (buttons, chips and badges, inputs, panels, list rows, popovers).
  *Done and implemented early (the visual-language items of the review): `docs/mocks/design-system.html`; the stylesheet is built on its tokens.*
- Updated mocks in `docs/mocks/` for the target interface. These replace the M1-era mocks as the reference.
  *Done: `docs/mocks/target.html`, including the approved sheen and depth.*

**Phase 2: implementation**
- Rebuild the styles on the tokens (no one-off values) and bring every screen in line with the approved mocks.
- **Dark mode**, following the system setting, built on the dark tokens. *A Theme setting (System, Light, Dark) and a provisional dark palette landed early; M12 replaces the palette with the designed dark tokens.* *Done: the dark tokens, applied in the screen pass.*
- Accessibility: every action reachable by keyboard with visible focus, WCAG AA contrast in both themes, labels for icon-only controls, and reduced motion respected. *Done.*
- Apply the brand: logo and wordmark in the app (sidebar, empty state, sign-in), the app icon on the window and taskbar, and icon files ready for the M22 installers. *Done.*
- Polish: empty, loading and error states; window title. *Done.*

**Done when:** Gloss has its logo, icon and visual style, every screen matches the approved mocks in light and dark, styles use the tokens throughout, and the accessibility checks pass.

**Order of the remaining work.** The visual-language PR also fixes the review's P1 problems on the existing screens (narrow windows, the activity strip, the failed-turn and deleted-session notices), labels the status line, and stops the whole page from scrolling. The rest comes in separate PRs:
- **Target mocks:** the updated layout mocks, the last Phase 1 item, including the sheen and depth from "Live up to the name". Review stop after it.
- **Screen pass:** Phase 2's pass bringing every screen in line with the approved mocks. *Done: the frame and sheet with the depth tokens, and every screen in `target.html` in light and dark.*
- **Failed-turn actions:** moved to their own milestone, right after M12.

*M12 done.*

## ~~M13 - Multiple agents~~

**Pulled forward: Codex support (first PR).** New Codex sessions, agent selection, session labels, a default-agent setting, and the existing threading, sign-in, model and resume flows. Uses `@agentclientprotocol/codex-acp` with its bundled Codex CLI. Agent-specific launch and bypass settings stay in `AgentConfig`. Existing Claude conversations remain with Claude.

Remaining work for M13, in separate PRs:

- **Gloss-managed MCP servers:** a global list of MCP servers passed through ACP's `mcpServers` in `session/new` and `session/load`, so agents share tools. Only transports the selected agent advertises are allowed. *Done: validated settings and schema, a global server list with Add/Edit/Remove and one-time imports from Claude and Codex, capability checks, and server lists on new/load. Changes apply before the next prompt or idle resume.*

*M13 done: checked live in the built app with a scratch data folder. Codex signed in from an empty `CODEX_HOME` through the browser, and one stdio MCP server from the global list was called by both a Claude (Haiku) and a Codex session.*

**Codex support is done when:** a new Codex session works end to end, including sign-in, threads, model selection and resume (or a lost-context notice if resume is unavailable).

**M13 is done when:** global MCP configuration works across agents, with reviewed one-time imports from native agent settings.

## ~~Failed-turn actions (after M12)~~
**Done.** Also includes non-interrupting background completion and history refresh, and a smaller, plain taskbar status dot matching the in-app state dots.
A failed turn offers what fixes it, instead of only saying it failed.

- **Sign in** when the turn failed because the agent needs authentication (ACP `auth_required`): opens the sign-in flow, then resends the prompt.
- **Retry** otherwise: resends the same prompt, in the same thread, with the same attachments.
- The actions sit on the failed-turn notice in the thread where the turn ran.

**Done when:** a turn that fails on an expired login can be fixed and resent from its notice, and any other failed turn can be retried with one click.

## ~~M14 - Open source agents and local models~~

**Done.** Guided OpenCode setup and custom ACP profiles are available, with connection tests, environment references, instruction-file delivery, capability diagnostics and removed-profile recovery. Agents without resume support preserve history and require a new conversation. Windows tests passed, including real OpenCode transport and a local Ollama tool call and file edit at 64K context. See `docs/ACP-PROFILES.md` and `docs/OPENCODE.md`.

Let users bring an ACP-compatible coding agent and run it with either a hosted model or a model served on their own computer. These are separate choices: the agent handles files, tools and the coding loop; the model supplies its responses. An open source agent can use a proprietary hosted model, and running an agent process locally does not mean its model runs locally. Update `SPEC.md` and design setup and connection diagnostics before implementation.

- **Compatibility spike first:** evaluate OpenCode as the initial supported open source agent. Its documented `opencode acp` command speaks ACP over stdio, and its provider configuration supports local model servers. Verify the current release, license, Windows launch behavior, instruction injection, permissions, model selection, tool events, cancellation, session listing and resume before committing to the integration. Record supported features and gaps; choose another ACP agent if the basic Gloss flow cannot work reliably.
- **Bring your own ACP agent:** add global agent profiles with a stable ID, display name, executable, argument array and environment-variable references, plus a Test connection action. Keep Claude Code and Codex available. Launch directly without composing a shell command; report missing executables, incompatible protocol versions, failed initialization and process exits clearly. Keep credentials in the agent's native credential store or referenced environment variables, and redact them from diagnostics. Removing a profile retains its conversations and allows restoring the profile to resume them.
- **One documented integration:** provide a guided profile for the selected open source agent using a user-installed executable. Explain installation and configuration with official links, show the detected version, and verify a connection before offering it for new sessions. Persist the profile used by each session and retain the chosen working directory. Do not silently switch an existing session to another agent or model provider.
- **Local inference path:** document and validate one complete setup, initially the selected agent connected to a user-managed Ollama server with a tool-capable local model. Gloss speaks ACP to the agent; the agent connects to the model server. Keep model/provider configuration in the agent's supported configuration unless it exposes that choice through ACP. Explain each component in setup and distinguish a loopback endpoint from a LAN or hosted endpoint. A server such as Ollama or LM Studio is not itself a coding agent and cannot be added as an ACP executable.
- **Capabilities and instructions:** offer attachments, model switching, session discovery/resume, steering, plans, usage and permission controls only where supported. Show unavailable usage or cost as unknown. Verify that Gloss's thread-routing instructions reach the agent without modifying the user's project instruction files. Preserve display history when resume is unavailable and require an explicit new-session action instead of claiming the agent retained context. Use the current permission behavior initially; M15 will add questions, permission modes and approval prompts across agents.
- **Failures and local expectations:** distinguish an unavailable model server, a missing model, authentication failure, insufficient memory and unsupported tool calling where the agent exposes those errors. Explain that speed, memory requirements and coding quality depend on the model and hardware. A local model does not guarantee an offline workflow: tools, MCP servers and other integrations may still access the network. Do not silently fall back to a hosted provider.
- **Scope:** connect to existing agents and model servers. Automatic agent installation, model downloads, starting/managing inference servers, GPU setup, training, a built-in coding-agent loop and support for every OpenAI-compatible endpoint are later work. Other custom ACP agents can be added, but only the tested integration is presented as supported.
- Verify with fake ACP agents and Windows smoke checks: profile persistence, launch failures and redacted diagnostics, capability differences, instruction delivery, thread routing, file edits, cancellation, restart/resume and removed-profile recovery. Run the documented local setup with hosted credentials removed and external networking disabled after installation and model download; confirm a prompt, tool call and file edit complete without a hosted fallback. Record the tested agent/server/model versions and hardware.

**Done when:** a user can add the supported open source agent, complete a coding task through Gloss using a local model without hosted credentials, discuss the result in threads, and restart and resume where supported. Custom ACP profiles survive restart, unsupported features are clearly identified, existing Claude Code and Codex sessions still work, and a stopped local server produces an actionable error.

Initial references (re-check during implementation): [OpenCode ACP support](https://opencode.ai/docs/acp/) and [provider configuration](https://opencode.ai/docs/providers/).

## ~~M15 - Questions and permission modes~~

**Done.** Form elicitations become question cards in the asking thread (Claude's AskUserQuestion included, in every mode); permission requests become approval cards unless the session is in a bypass mode or Gloss auto-approves; a per-session mode picker in the status line replaces the bypass item, with a `permissionMode` default (global, per-project override, bypass by default) and saved per-session modes. Waiting turns show "Waiting for you" in the status line, strip, sidebar and thread, and notify when Gloss isn't focused. URL elicitations are declined. Verified live on Haiku 5.5 through the Claude adapter (`src/main/claude.integration.test.ts`, opt in with `GLOSS_CLAUDE_LIVE=1`) and in the built app.

Let the agent ask the user things, and let the user choose how much it may do without asking. Replaces SPEC → Permissions ("no approval UI"); update it in this milestone.

- **Agent questions:** advertise ACP's `clientCapabilities.elicitation.form` and answer `elicitation/create` requests with a question dialog built from the request's JSON Schema: single and multiple choice, free text, and the agent's "other" answer where it allows one, plus Decline and Cancel. With form support the Claude adapter turns on Claude Code's AskUserQuestion tool (disabled today because Gloss doesn't advertise it) and sends its questions this way; MCP servers' elicitations arrive the same way. The question shows in the thread whose turn asked it. URL elicitations (open a link, wait for `session/complete_elicitation`) are optional.
- **Permission modes:** a per-session mode picker from the agent's `modes` (Claude Code: Manual, Accept edits, Plan, Auto, Bypass permissions), set with `session/set_mode` and kept in sync from `current_mode_update`. It replaces the status line's "bypass" item. A default mode in settings (global, with a per-project override) replaces always entering `bypassModeId`; bypass stays the default.
- **Approval prompts:** in a mode where the agent asks, `session/request_permission` shows an approval prompt (the tool call's title and what it will run or change, with the agent's options: allow once, allow always, reject) in the thread of the running turn, instead of being auto-approved. Auto-approval remains for agents without a bypass mode only if the user picks it.
- **Waiting on the user:** a turn waiting on a question or an approval is still running (queued messages wait), shows "Waiting for you" in the status line and sidebar, and sends an OS notification when Gloss isn't focused. Cancel answers it with `cancelled`.
- Agent-agnostic: everything comes from ACP modes, permission options and elicitation schemas. Verify first: the SDK's elicitation request and response shapes (`CreateElicitationRequest`/`CreateElicitationResponse`), and how the Claude adapter maps AskUserQuestion (several questions per request, multi-select, the custom answer).

**Done when:** Claude Code can ask a multiple-choice question mid-turn and gets the answer from a Gloss dialog, and a session switched to Manual asks before each edit or command and continues or stops based on the answer.

## ~~M16 - Visual feedback (experimental)~~

**Done.** **Capture the screen** in the composer's Attach menu, `Ctrl+Shift+S`, or a global shortcut from any app (`Ctrl+Shift+PrtSc` by default, a setting) open a ShareX-style region overlay on every display (drag a region, click a window, Space for the display under the cursor; window hover on Windows only), then an annotation canvas filling the window, with zoom and pan, numbered pins and notes, pen, highlighter, box and arrow. The flattened image goes to the composer (Edit reopens it); its pin list is sent after the message text, and each pin opens its own thread from the sent message. One overlay instead of a palette of modes. Verified live in the built app on Haiku 5.5: the agent named every pin's element, a pin thread answered about its pin, and pins and the thread survived a restart and resync. See `docs/mocks/visual-feedback.html` and SPEC → Visual feedback.

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
- Annotating an image pasted, dropped or picked into the composer, not only a capture.
- Window hover on macOS (`CGWindowListCopyWindowInfo`) and Linux X11 (`_NET_CLIENT_LIST_STACKING`), once they can be tested there; Wayland doesn't let apps see other windows.
- A region across two displays.
- A blank canvas for sketching mockups and diagrams.
- Several images in one message: before and after, or a sequence of steps.
- Short screen recordings for interactions and animations.
- The agent annotates back: it returns a screenshot with its own numbered marks.
- Verify loop: after a fix, re-capture the same region and compare with the original.
- Automatic marks: segment the capture and number regions so you only pick the ones you mean.
- An MCP tool so the agent can ask you for a screenshot of something.

## ~~M17: Agent-native conversation rewind~~

**Done.** Claude Code and Codex rewind by forking their saved native history at the selected boundary, preserving structured records without a synthetic transcript prompt. The selected prompt and attachments return to the composer; retained message IDs and thread anchors survive replay and restart. Failed fork loads can be retried. Unsupported agents offer no rewind, and transcript reconstruction and its size cap are removed except for pending legacy reconstructions. Conversation rewind leaves project files unchanged. Implemented in `e3d06fe`.

Replace the current fresh-session transcript prompt with native history restoration where the agent supports it. Keep the existing rewind interaction, draft restoration and conversation-only scope. Update `SPEC.md` in this milestone.

- **Compatibility spike first:** verify the installed Claude Code and Codex adapters and their underlying session APIs. Record support for resuming or forking at a historical message, capability negotiation, cancellation requirements and persistence across restart. Claude's adapter currently has a message-targeted `session/fork` extension backed by the SDK's `upToMessageId`; validate its contract and exact boundaries before adopting it. Standard ACP fork support alone does not establish historical-point support. Investigate Codex separately; document unsupported custom agents honestly.
- **Preserve structured history:** continue from the agent's original user, assistant and tool records, including image blocks and tool results. Do not flatten retained history into a new user message or reattach every image to that message on the native path. Agent context limits and compaction still apply; native rewind does not imply unlimited context or restoration of private internal state.
- **Exact rewind boundary:** map Gloss messages to stable native history identifiers. Remove the selected user message and everything after it while retaining every entry of the preceding turn, including trailing tool results. Cover cancelled turns, steering, repeated identical messages, compaction and thread routing. Fail explicitly when the boundary cannot be resolved; never silently resume the full discarded history.
- **Keep the interaction immediate:** preserve double Escape behavior, automatic rewind of the latest cancelled turn, and restoration of the selected prompt and attachments into the composer. Project files stay unchanged. Separate local UI updates from agent setup, without claiming the native operation succeeded before it has; define recovery for a failed native restore without losing the draft or retained history.
- **Persist and reconcile:** save the native session or branch identity and rewind boundary, preserve retained message IDs and pin/thread anchors, and reconcile replay without resurrecting removed turns or duplicating retained entries. Verify restart before the next prompt and after it. Handle conversations already created through the reconstruction fallback.
- **Explicit fallback policy:** decide what unsupported agents can offer after the spike. Clearly distinguish native restoration from transcript reconstruction; never silently substitute a summary or drop images and tool output. Remove the arbitrary reconstruction byte cap as a blocker to local rewind, and report actual provider constraints separately from Gloss history retention.
- **Verification:** exercise both supported built-in agents with long, image-heavy sessions, mixed tool calls and results, cancellation followed by immediate rewind, repeated rewinds, restart/replay, native-startup failures and recovery. Document tested adapter versions and remaining capability gaps.

**Done when:** supported agents continue from the exact retained structured history without a synthetic transcript prompt; discarded turns do not return after reconnect or restart; the selected message and attachments are ready to edit in the composer; project files remain unchanged; and long or image-heavy conversations are not blocked by Gloss's arbitrary snapshot limit. Unsupported agents have a documented, explicit behavior rather than an assumed native rewind.

## ~~M18: Remote and mobile~~

**Done.** Phones connect over Tailscale to a bridge in the main process (HTTPS and a WebSocket on the Tailscale address only), which runs the windows' own handlers for an allowlist of calls. TLS uses the Let's Encrypt certificate Tailscale issues for the machine's `ts.net` name, renewed daily and swapped in without dropping phones, instead of a self-signed certificate pinned at pairing: a web page can't pin, and the PWA and push need a trusted certificate. Pairing by a one-time QR code sets an HttpOnly device token that carries over to an iOS Home Screen app; Settings → Phone lists devices and removes them at once. The phone client covers sessions, threads full screen, send, queue, steer and stop, questions and approvals, images and the status line; web push notifies when no window is focused, except about a session open on the phone. Verified on an iPhone; Android is untested. Design: `SPEC.md` → Remote and mobile.

Drive Gloss from a phone while the desktop app runs the agents. The desktop stays the only place agents, ACP and the database live; the phone is another client of the main process. Adds a section to `SPEC.md` (update it in this milestone).

- **Bridge in the main process:** off by default, turned on in Settings. Serves the same API the preload exposes (requests and the event stream) over an authenticated WebSocket, plus a mobile web client. No new agent-facing logic: the phone's calls go through `SessionManager` like the renderer's, so a turn started on the phone shows live on the desktop and the reverse.
- **Pairing:** Settings shows a QR code with the address and a one-time pairing secret; scanning it gives the phone a long-lived device token. Paired devices are listed with their last use and can be revoked. Every request needs a valid token. The bridge gives full control of agents that run commands without asking, so treat it as remote code execution: TLS only, and nothing listens until the user turns it on.
- **Reachability:** start with the local network. For away from home, document a private network (Tailscale or similar) rather than building a relay; a hosted relay is a later option, not part of this milestone.
- **Mobile client:** a phone layout of the session list, conversation and composer, with threads opened full screen. Covers the daily loop: read the log, open and reply in threads, send, queue, steer, cancel, resume a paused queue, see the status line (context, plan limits). Desktop-only features (settings, review sessions, visual feedback) can stay desktop-only. Agent output is untrusted here too: the same sanitized markdown rendering, and no `file://` or local-path links.
- **Waiting on you:** with M15, questions and approval prompts can be answered from the phone; a turn that ends or needs an answer can notify the phone (web push from the PWA) when the desktop isn't focused.
- **Desktop asleep or closed:** the phone shows "Gloss is offline" and reconnects on its own; nothing is queued on the phone while offline.
- Verify first: serving the client from the main process without loosening the renderer's security settings, TLS on a LAN address (self-signed certificate pinned at pairing, or the private network's certificates), and web push on iOS (needs an installed PWA).

**Done when:** you can pair a phone by scanning a QR code, see the same sessions as the desktop, start and steer a turn in a thread from the phone while watching it stream on both, and a revoked phone can no longer connect.

## ~~Worktrees (pulled ahead of M19)~~

**Done.** New session's menu picks where (the project folder, a new worktree, or a starred existing one) and the agent, each with a default star; phones can start in a new worktree too. A new worktree gets a `gloss/<name>` branch under `~/.gloss/worktrees`, runs the project's setup command while messages wait, and its agent learns where it works from a first line only it sees. The Worktrees screen lists the project's folders with what each holds and its sessions, and stars, reviews and removes them. Reviews belong to a folder (**Review changes** in a session's header, `Ctrl+Shift+D`, and a draft's folder dropdown). Gloss removes the worktrees it made once their last session is gone and nothing is left in them. Live on Claude Code with Haiku through the built app (menu, setup, note, agent's folder and branch, screen, automatic and confirmed removal); Codex was checked in the spike, not through the app. OpenCode untested (not installed). Changes from the plan below: the agent is told in its first message, not its instructions (see the spike); unfinished commits are those on no other branch, local or remote, rather than on no remote branch, since a repository without a remote made every worktree look unfinished; a failed setup also adds a note, and messages wait in the ordinary queue rather than with a "Waiting for setup" label. Starting a session in an existing worktree isn't open to phones, and there is no `Ctrl+Shift+N` after all. Importing an agent's session now keeps its listed folder, which fixes CLI worktree sessions resuming in the project folder. Design: `SPEC.md` → Worktrees.
Let sessions work in their own git worktrees, so big pieces of work can run side by side without touching each other's files, while sessions that should share a checkout still can. Worktrees stay out of the way: Gloss creates and removes the ones it makes, and the user never has to manage them by hand. Agent-agnostic (Claude Code, Codex, OpenCode, custom ACP profiles): an agent just starts with a worktree folder as its cwd. Update `SPEC.md` in this milestone (Projects and sessions, Review sessions, Session windows, Status line, Keyboard shortcuts, Remote and mobile, and a new Worktrees section).

**Design reference:** [worktrees mock](mocks/worktrees.html): the New session menu, an existing worktree as the default, the Worktrees screen, Remove, and setup in progress or failed.

**Spike first** (findings go in this milestone): `git worktree add/list/remove` on Windows with folders under `~/.gloss` (long `node_modules` paths included); each adapter started with a worktree cwd (Claude Code files transcripts by cwd, so check `session/list` with each worktree's path finds its sessions, and that `session/load` resumes them); how each agent can be told it works in a worktree (Claude's `_meta.systemPrompt`, Codex's `customInstructions` on `session/new`, OpenCode and custom profiles); Codex's sandbox in a folder outside the project.

**Spike findings (2026-10-28, git 2.37.2 for Windows, Claude adapter 0.89.1 on Haiku, Codex adapter 2.2.2; `scripts/probe-worktree-git.mjs`, `scripts/probe-worktree-agent.mjs`):**
- `git worktree add -b gloss/<name> <folder> <base>` works with a folder outside the repository; `git worktree list --porcelain` gives the same list from any worktree (`worktree`, `HEAD`, `branch refs/heads/…` stanzas, plus `prunable` for a folder deleted behind git's back, which `git worktree prune` drops). Checking out a worktree's branch elsewhere fails ("already checked out at"). An existing branch name fails `add -b`, so a generated name that collides is retried.
- `git status --porcelain` ignores ignored files (an installed `node_modules` reads as clean); untracked files show as `??`. `git rev-list --count <branch> --not --remotes` counts unpushed commits, and goes back to non-zero once the remote branch is deleted (a squash merge), as the design expects.
- **Removal needs long paths.** Plain `git worktree remove` of a worktree whose ignored `node_modules` has a 657-character path fails with "Filename too long", after unregistering the worktree and leaving the folder half deleted. `git -c core.longpaths=true worktree remove` removes it cleanly; so does deleting the folder from Node (`rmSync`) and then `git worktree prune`. A worktree with modified or untracked files needs `--force`, which Gloss passes only after its own unfinished-work check or the user's confirmation. The branch then needs `branch -D` (unmerged commits make `-d` refuse).
- **Both agents work in a worktree cwd:** a file the agent wrote landed in the worktree, not the project folder; `pwd` and `git rev-parse --abbrev-ref HEAD` gave the worktree and its branch; `session/close` then `session/load` with the worktree cwd resumes; `session/delete` removes the transcript.
- **`session/list` differs.** Claude's list for the project folder also returns the sessions of its worktrees, each with its own `cwd` (the worktree path); its list for a worktree returns only that worktree's. Codex's list for the project folder doesn't include worktree sessions, so Gloss lists each worktree's folder too and merges by session id. Claude Code files the transcript under the worktree's folder in `~/.claude/projects`, but keeps auto-memory with the main repository (a `memory/` folder under the project folder's entry).
- **Existing bug:** `agentSessions` drops the listed `cwd` and an imported session gets the project's path, so a session started in a worktree from the CLI resumes in the project folder. Imports keep the listed `cwd`.
- **Telling the agent:** Gloss gives OpenCode and custom profiles their instructions per agent process (a file at launch), not per session, so a worktree path can't go there. Instead the first message carries a first line only the agent sees, like a review's range note: `[You are working in a git worktree at <folder>, on branch <branch>. The project folder is <folder>.]`, recognized on replay like `isRangeNote`. Claude and Codex both followed it. Codex titles a session with its first prompt, note included, so a title starting with the note has it stripped.
- **Codex's sandbox isn't a worktree problem:** in its sandboxed `agent` mode on Windows, `git commit` fails with "detected dubious ownership" in a plain project folder as well as in a worktree (its commands run as another user). Full access (Gloss's default for Codex) commits normally. Not addressed here.
- OpenCode isn't installed on this machine; it takes the cwd per `session/new` like the others, and the note is plain prompt text. Not tried live.

- **Words.** The **project folder** is the project's own checkout. A **worktree** is any other entry of `git worktree list` for it. Gloss records the worktrees it creates (**managed**); ones the user made are shown and handled the same way, except that only managed ones are ever removed without being asked.
- **Unfinished work.** A worktree has unfinished work if it has uncommitted changes (modified, staged or deleted tracked files, or new files git doesn't ignore; ignored files such as `node_modules` don't count), commits on its branch that are on no remote branch, or an open or draft PR for its branch. A PR merged at the branch's current commit counts as finished even when its remote branch was deleted. Stashes don't count.
- **Creating one.** A new worktree gets a new branch with a generated name (`gloss/<adjective>-<noun>`, like `gloss/swift-otter`; the project's **worktree branch prefix** setting replaces `gloss/`, and a bare word gets a `/`. A prefix like `dev/` when a `dev` branch exists is refused, since git can't hold both) and a folder at `~/.gloss/worktrees/<repo folder name>/<name>`. Its session's first message renames the branch (once, before the message goes out) to `<prefix><first words of the message>`, numbered if taken; the folder keeps its name, since the agent runs in it and its transcript is filed by its path. Messages sent during the rename wait in the queue; if git can't rename it, the generated name stays. It branches from the project's **base branch** setting: the project folder's current branch (default) or a named branch, fetched first when it is a remote branch. The project folder's uncommitted changes don't come along. If git can't create it, no session is created and the error shows in the sidebar note.
- **Setup command** (a project setting, empty by default): run in each new worktree once it exists, with its output in the session's log (folded behind Show output). The session opens at once; a message sent meanwhile waits like a queued one ("Waiting for setup") and goes out when setup succeeds. If setup fails, the worktree and session stay: the log shows the failure and its output, and the waiting message is paused, with **Send anyway** and **Edit**, so the user can ask the agent to repair it first.
- **The agent is told** that it works in a worktree, on which branch, and where the project folder is, in a first line of the session's first message that only it sees (see the spike findings).
- **A session never moves.** It stays in the folder it was born in. Worktree sessions sit in the project's normal session list with no marker; the status line's branch and folder show where they are. The list also shows the agent's own sessions from each worktree's folder (`session/list` per folder).
- **New session menu** (the caret beside New session): two short lists, each with a star for its default. **Where:** Project folder, New worktree, and the default worktree when an existing one is starred (a third row with its branch); then **In an existing worktree…**, which opens the Worktrees screen. **Agent:** the agents, as today. Clicking a row only selects it; **Start** (or Enter) starts, and the lists open on the defaults. **Review leaves this menu.** The default agent stays global; the default place is per project. The main button starts the defaults and shows the agent, with a branch icon (and the worktree's short name for an existing one) when the place isn't the project folder.
- **Shortcuts:** `Ctrl+N` starts the defaults; `Ctrl+Shift+N` starts the default agent in a new worktree.
- **Worktrees screen:** **Worktrees** in the sidebar foot, between Search and Settings, with a count of worktrees that have no sessions. It opens in the center like Settings (Done or Esc closes it). A card for the project folder, then one per worktree: branch, a star (make it where New session starts), folder, state ("Clean", or its unfinished work), its sessions as chips that open them (a dot while one works), **New session** (default agent), **Review** and **Remove** (not on the project folder). A worktree without sessions says its work is kept. The lede names the base branch and setup command and links to Settings → the project, where they live.
- **Removing.** Remove asks first when there is anything to lose: its unfinished work and its sessions, listed. It deletes the worktree folder, its branch, and its sessions as Delete does (the agent's copies too). A clean worktree without sessions goes at once.
- **Removed without asking:** when the last session (review sessions included) of a managed worktree is deleted and it has no unfinished work and isn't the default place, Gloss removes it and its branch silently. Otherwise it stays on the Worktrees screen. When the default worktree is removed, the default goes back to the project folder.
- **Reviews.** A review belongs to a folder. **Review changes** in a session's header, beside Pop out, and `Ctrl+Shift+D` review that session's folder; with no session open, `Ctrl+Shift+D` reviews the project folder; the Worktrees screen's **Review** reviews that folder. A draft review can switch folder (a picker in its header) until something is sent; its range resets to that folder's default. The review session runs in that folder, so its fixes land there.
- **Phone:** New session can start a session in a new worktree. No Worktrees screen on the phone.
- **Not in this milestone:** moving a session to another folder, applying a worktree's changes to the project folder (work leaves through its branch and a PR), renaming branches, and copying ignored files other than through the setup command.
- **Tests:** git operations against throwaway repositories created in a temp folder by the tests (no committed fixtures); `SessionManager` against the fake agent with a worktree cwd, including the setup wait, its failure and the paused message; unfinished-work rules, including a squash-merged PR with a deleted remote branch.

**Done when:** a session can be started in a new worktree from the menu, the shortcut and the phone, set up by the project's command while its first message waits, and run beside another session without touching its files; existing worktrees (the user's included) can be joined, reviewed, starred as the default and removed from the Worktrees screen; managed worktrees with nothing left in them disappear when their last session is deleted, and nothing with unfinished work is ever removed without asking. Tried live with Claude Code and Codex on Haiku.
