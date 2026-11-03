# Performance

The design choices are in `SPEC.md` (Performance). This page covers how to measure them and what keeps them from regressing.

## Regression tests (`npm test`)

Deterministic: they count, never time, so they don't flake.

| What | Test |
| --- | --- |
| A streamed chunk renders only its own message: no other answer, question or screenshot in the log | `src/renderer/src/streaming.test.tsx` (render counts of `Markdown` and `CaptureFigure`) |
| A 400-chunk answer sends one message event and 399 `messageText` events, each about its chunk's size, and runs a fixed number of SQL statements for the turn (not one per chunk) | `src/main/sessions.test.ts`, "streams a long answer with a bounded number of writes…" |
| Text streamed but not written yet is written before anything reads the log, and on close | `src/main/sessions.test.ts`, "writes streamed text before anything reads the log…" |
| Opening a session takes the same number of statements with 500 messages as with 20 | `src/main/sessions.test.ts`, "opens a large session with a fixed number of statements" |
| Older history mounts only near the view, in batches sized by render time | `src/renderer/src/Log.history.test.tsx` |
| A window's session view leaves screenshots out (its size doesn't grow with them); a screenshot loads once when shown | `src/main/bridge.test.ts` (`deferImages`), `src/main/sessions.test.ts` (`imageData`), `src/renderer/src/streaming.test.tsx` |
| Code renders plain on mount and is colored in a background render; highlighting arriving is a transition | `src/renderer/src/Markdown.cache.test.tsx` (two parses on mount), `src/renderer/src/highlight.transition.test.tsx` |
| Size budgets: the main window's startup scripts, the whole renderer, the main process | `src/main/bundle.test.ts` (needs a build in `out/`; CI builds before testing) |

## Benchmark (`npm run bench`)

Timed, on demand, not in CI: shared runners are too noisy for wall-clock budgets.

```powershell
npm run bench                         # build, seed, measure, compare with this machine's baseline
npm run bench -- --update-baseline    # record this run as the baseline (commit the file)
npm run bench -- --skip-build --only=stream,soak --soak-minutes=10
npm run bench -- --profile            # also save CPU profiles of the renderer and main process to out/bench/profiles
npm run bench -- --app=..\gloss-old   # measure another checkout (a worktree of an older commit, built there)
```

What it does (`scripts/bench/`):

1. **Seeds** a scratch user data folder through the real `Store` (`seed.ts`): two 300-turn sessions (one with about 150 screenshots of mixed aspect ratios, most with pins; one code-heavy), three 80-turn sessions and 25 small ones. Answers are long markdown with code blocks in several languages, each turn has reads, commands, searches and edits with diffs, and there are dozens of threads with replies. The seed is cached in `out/bench/seed-*` until its code changes.
2. **Launches the built app** with `--user-data-dir` on a copy of the seed, a custom ACP profile for `fake-agent.mjs`, and scratch `CLAUDE_CONFIG_DIR` and `CODEX_HOME` (a placeholder Codex key so listing sessions doesn't ask to sign in; nothing is sent to any model). The fake agent replays each session's seeded history on load, so opening one changes nothing, and streams long answers (16,000 characters in 6 to 18 character chunks every 30 ms, with tool calls) on prompts.
3. **Drives it over CDP** (`--remote-debugging-port` for the window, `--inspect-brk` for the main process, where it injects timing into each page before it loads and counts the events sent to windows).

It records, into `out/bench/results.json`:

- **Startup** (3 launches): when the window is shown (Gloss shows it once its first frame is ready), first contentful paint, the sidebar shown and interactive (shown, then a second without long tasks), the large session shown, and when the main thread last had a long task.
- **Opening a large session** (the code-heavy one), **switching sessions**, **opening a thread** and **search**: click (or key) to content, and long tasks after it.
- **Streaming** into the image-heavy session while typing in the composer and scrolling the log: frame times, renderer long tasks and script, layout and style time, slow input events (Event Timing), main-process CPU, and events and bytes sent to windows.
- **Memory**, after a compressed hour (`--soak-minutes`, default 4): switching sessions, scrolling the image-heavy session to the top and back, opening threads and short turns. Process working sets, both JS heaps, DOM nodes and images.

### Baseline

`docs/performance/baselines/<machine>.json` holds a machine's headline numbers (`summary` in the results). A run fails when a number is over 25% worse than the baseline (and past a small absolute slack), or when any renderer long task while streaming is over 50 ms, whatever the baseline. Baselines are per machine (named by OS, CPU and thread count) and only change with `--update-baseline`, in a commit of their own or with the change that explains them.

## M25 results

Measured November 3, 2026 on Windows 11, Intel i9-12900KS (24 threads), Electron 44.7.0, with the same seeded data on both sides: "before" is commit 77bea1c, built in a worktree and seeded by its own `Store` (`--app`); "after" is this milestone. Startup is the median of three launches; the soak was 3 minutes before and 4 after. Raw results: [m25-before.json](m25-before.json), [m25-after.json](m25-after.json).

| Metric | Before | After | Change |
| --- | ---: | ---: | ---: |
| startup.windowShownMs | 506 | 475 | −6% |
| startup.firstPaintMs | 798 | 874 | +9% |
| startup.sidebarInteractiveMs | 20,325 | 696 | −97% |
| startup.largeSessionShownMs | 1,978 | 522 | −74% |
| startup.busyUntilMs | 20,325 | 696 | −97% |
| openLarge.ms | 411 | 102 | −75% |
| openLarge.busyUntilMs | 992 | 170 | −83% |
| switch.p50Ms | 171 | 67.5 | −60% |
| switch.p95Ms | 1,204 | 109 | −91% |
| thread.ms | 89.8 | 34.6 | −61% |
| search.p50Ms | 403 | 266 | −34% |
| stream.mainCpuMs | 3,203 | 1,297 | −60% |
| stream.ipcKB | 3,195 | 221 | −93% |
| stream.rendererScriptMs | 31,571 | 8,865 | −72% |
| stream.rendererLongTaskMs | 26,383 | 0.0 | −100% |
| stream.maxLongTaskMs | 287 | 0.0 | −100% |
| stream.typingFrameP95Ms | 253 | 13.4 | −95% |
| stream.scrollFrameP95Ms | 227 | 26.7 | −88% |
| soak.rendererWorkingSetMB | 1,963 | 298 | −85% |
| soak.totalWorkingSetMB | 2,403 | 738 | −69% |
| bundle.rendererScriptKB | 10,856 | 10,863 | +0% |
| bundle.mainKB | 980 | 986 | +1% |

What each fix addressed, from the profiles (`--profile`):

- **Streaming re-rendered the whole log.** Every chunk re-rendered every row; each screenshot rebuilt its multi-megabyte data URL, which React then compared with the old one character by character (18 s of `updateProperties` in a 45 s stream). Fixed by memoized rows with a version string per message, and one data URL per attachment. Renderer long tasks while streaming went from 26 s to none.
- **Each chunk sent and rewrote the whole message.** 1,381 events and 3.2 MB per turn, and an `UPDATE` (plus search reindex) of the full text per chunk, with an fsync each (`synchronous = FULL`): 5 s of main-process time per turn. Fixed by `messageText` additions, coalesced writes and `synchronous = NORMAL`.
- **The whole history mounted after opening.** About 240,000 DOM nodes and 1.5 GB in the renderer for the image-heavy session, and 20 seconds of background mounting in tasks up to 290 ms. Fixed by mounting older entries only near the view, in batches sized by render time.
- **Screenshots travelled with the log.** Opening the image-heavy session read, parsed and sent about 140 MB of base64 (190 ms in the main process, more in the renderer). Fixed by storing image data in its own table and loading each image when its row shows.
- **Coloring code was one long task** (165 to 190 ms) when highlighting became available or a batch mounted. Fixed by rendering code plain first and coloring it in interruptible background renders. What remains at startup are background renders of 50 to 110 ms, each one message's code blocks colored at once (mostly Shiki compiling a grammar on first use); splitting them per code block would be the next step.
- **Session queries read message rows** for the latest activity and the composers' history, walking past large text and attachments: 64 to 90 ms per call. Fixed by indexes.

`startup.firstPaintMs` is first contentful paint, which now comes after those background renders; the window itself shows sooner (`windowShownMs`, when its first frame is ready), with the sidebar and session already in it. Search (34% faster) and thread opening gained from the same changes; neither needed its own fix. Bundle sizes didn't change: what loads before the first window is React, CodeMirror (the composer), the markdown parser and Shiki's core with its common languages, all used by the first screen.

### Other benchmarks

`npm run bench:app-startup` (startup and resizing with a copy of your real Gloss data) and `npm run bench:new-session` (backend session creation against the real adapters) predate this one; see `app-startup.md` and `new-session-latency.md`.
