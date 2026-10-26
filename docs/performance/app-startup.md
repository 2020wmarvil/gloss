# Application startup and resize investigation

Measured October 25, 2026 on Windows 11, Intel i9-12900KS, Electron 44.7.0 / Node 24.21.0. The initial investigation preceded the implementation below. All builds include the immediate new-session composer change already present in the working tree.

## Implementation and follow-up measurements

Implemented the first three priorities: retain unchanged Markdown trees and tool rows across layout/metadata updates; paint the composer before mounting a large history in idle batches; and return known agents synchronously while optional availability checks finish in the background.

Markdown's cache includes text, source marks, visible reply counts, active/running anchors and highlighting version. Event handlers use current callbacks even when the rendered tree is reused. Logs no longer measure scroll height on every render. Small logs mount immediately; larger logs add eight groups at a time after a paint opportunity, starting with the recent end. Existing rows and composers retain their identity, scrolled views retain a visible message when older entries are prepended, and explicit reveals can display their target immediately. This is incremental mounting, not history virtualization: older history ultimately remains available in the DOM.

Known-agent listing returns immediately, then an `agents` event supplies updated availability. Availability checks are shared, cached and ignore obsolete results; manual connection tests supersede older checks. Discovery requests are shared while pending, and a newly available agent is discovered without relisting every other agent.

Three fresh processes per follow-up case, using the same benchmark and machine:

| Largest conversation, 79 messages / 167 tool calls | Before | After |
| --- | ---: | ---: |
| Built: mean first composer frame | 572 ms | 335 ms |
| Built: mean window show | 507 ms | 343 ms |
| Built: mean startup time in tasks over 50 ms | 722 ms | 0 ms observed |
| Built: resize frame p95 | 53.4 ms | 13.4 ms |
| Built: mean resize JavaScript time | 2,387 ms | 141 ms |
| Development: mean first composer frame | 1,534 ms | 1,444 ms |
| Development: mean startup time in tasks over 50 ms | 1,361 ms | 71 ms |
| Development: resize frame p95 | 147 to 213 ms | 13.4 ms |

The built case reduced measured resize JavaScript by about **94%** and the mean first composer frame by **41%**. Every built follow-up run completed with the same 79 messages, 167 tool calls and 4,738 final DOM nodes as the original large-conversation baseline. Each made three discovery requests. The known-agent IPC handler took about 1.4 to 1.7 ms, with availability delivered later. Development's initial module loading remains substantial; its repeated startup stalls and resize work are much lower.

The latest-conversation follow-up averaged 344 ms for the first composer frame, with zero observed tasks over 50 ms and 13.4 ms resize frame p95. That live fixture had grown to 31 messages and 132 tool calls, so the largest-conversation measurements above provide the comparison with matching history counts. These remain exploratory sequential runs, with instrumentation enabled and no claim of measured sub-100-ms input latency.

Follow-up raw data: [app-startup-after.json](app-startup-after.json). Validation includes a successful build and typecheck, targeted lint, and 503 passing tests (five existing skips). Regression coverage checks Markdown cache invalidation and fresh callbacks, source selections, replies, streaming updates, draft preservation, recent-first history mounting, scroll preservation, explicit reveals, and deferred availability/discovery.

## Findings

The strongest finding is repeated conversation rendering. Window width is React state in `App`; each resize passes through `SessionPane`, `Conversation` and `Log`. Agent messages receive fresh anchor objects and callbacks, and `Markdown` runs the Markdown pipeline again. `Log` also reads `scrollHeight` and writes `scrollTop` in a layout effect after every render. The CPU profiles show Markdown tokenization, tree construction, React reconciliation, and the log's layout effect during resize.

This scales with restored history and affects startup as background results arrive. The largest conversation in the snapshot has 79 messages, 167 tool calls, about 44,000 message characters, and about 4,700 DOM nodes after restoration. The latest conversation has 21 messages and about 80 tool calls. Neither is an artificially generated stress fixture.

Main-module loading averaged 24 to 31 ms across the experiments. In the built baseline, the native window was created around 125 to 137 ms after launch. Local initial IPC handlers were generally under 15 ms. These measurements do not support prioritizing SQLite or main-module loading over renderer work.

## Measurements

Three fresh Electron processes per row. Averages are across those three runs; the resize frame figure is the range of their individual p95 values.

| Renderer / restored conversation | Mean first composer frame | Mean startup time in tasks over 50 ms | Resize frame p95 | Mean resize JavaScript time |
| --- | ---: | ---: | ---: | ---: |
| Built / latest | 505 ms | 97 ms | 13.4 ms | 1,262 ms |
| Built / largest | 572 ms | 722 ms | 53.4 ms | 2,387 ms |
| Development / latest | 3,596 ms, including first-run outlier | 418 ms | 66.7 ms | 3,150 ms |
| Development / largest | 1,534 ms | 1,361 ms | 147 to 213 ms | 3,862 ms |

The development/latest composer observations were **7,984, 1,261 and 1,544 ms**, in that order. The first slow run spent most of its time before DOM readiness: the window existed at 137 ms, but `dom-ready` arrived at 7,655 ms. Subsequent development launches were much faster. Development server module loading, transformation, and dependency caches are likely contributors to that first-run delay; these measurements do not isolate those costs individually. No Vite cache was deliberately deleted, so the first observation is not a controlled cache-cold benchmark.

Showing a composer does not mean startup work has finished. In the built/largest runs, tasks over 50 ms continued until approximately **1.7 to 2.0 seconds after launch**, with the longest individual tasks taking **161 to 174 ms**. Development/largest had individual tasks of **300 to 302 ms**, and long tasks continued until about **2.8 to 3.0 seconds**. This explains how a window can already be visible while interactions still feel delayed.

Raw results, IPC timings, CPU sample summaries and phase timings: [app-startup-measurements.json](app-startup-measurements.json). The raw file preserves each experiment's samples; earlier runs predate automatic aggregate summaries and resource timing collection.

## Isolation experiments

Diagnostic variants modify a temporary copy of the built renderer. They do not edit production source or the normal build output. Both use the largest conversation and three processes.

| Experiment | Mean resize JavaScript | Mean renderer task time during resize | Resize frame p95 | Mean startup time in tasks over 50 ms |
| --- | ---: | ---: | ---: | ---: |
| Baseline | 2,387 ms | 3,818 ms | 53.4 ms | 722 ms |
| Skip the React window-width state update | 42 ms | 1,348 ms | 13.4 ms | 722 ms |
| Skip syntax-highlighter initialization | 2,371 ms | 3,830 ms | 53 to 67 ms | 722 ms |

Skipping window-width updates removed about **98% of the measured resize JavaScript**. It also reduced native layout time during the sweep from about 612 ms to 312 ms, consistent with avoiding extra DOM/layout work. The remaining task time includes Chromium processing, styling and layout. Metrics overlap and should not be added together.

The width-update variant is not a production solution: automatic pane sizing and collapse depend on that state. It demonstrates that unchanged conversation content should be isolated from those updates. Its first launch from the copied renderer path also had a 1,283 ms composer observation; use it to compare steady resize behavior, not to claim a startup improvement.

Disabling highlighter initialization did not materially reduce startup blocking or resize work in this fixture. The baseline eagerly requests 13 grammars and notifies every subscribed Markdown component when initialization completes, but that is a lower priority than repeated log rendering. This does not rule out higher highlighting costs for conversations containing much more code.

## Recommended implementation order

1. **Keep unchanged message rendering out of resize and metadata updates.** Give message rows and their Markdown content stable props and callbacks, memoize at the message boundary, and retain parsed content until its text or relevant annotations change. Preserve selection offsets, thread anchors, reply counts and streaming updates. Window sizing should update pane layout without rebuilding unchanged history. Throttling resize events alone would leave the expensive render path intact.
2. **Limit scroll measurement to actual content and viewport changes.** Investigate the unconditional `Log` layout effect alongside its existing resize observer. Keep scroll anchoring and bottom pinning, while avoiding repeated synchronous layout reads after unrelated updates.
3. **Render the application shell and composer before expensive history.** Restore a recent portion of history first, then load older content in bounded work. Choose chunking or virtualization based on measurements after message rendering is cached. This applies the immediate-composer approach to reopening an existing conversation.
4. **Keep optional startup work from triggering expensive log renders.** `agents:list` awaits OpenCode availability before returning any agents. In the built baseline it took about 367 ms; external-session discovery then ran for all available agents. Return known agent entries promptly and check optional availability separately. Git/PR and discovery results can fill in after the shell appears. Their request durations are asynchronous latency, not evidence that the main thread was blocked for the whole request.
5. **Split startup imports where useful.** The built renderer entry is approximately 2.82 MB uncompressed, with settings, review, annotation, Markdown and editor code reachable from the initial import graph. Lazy loading secondary screens could help initial module work, particularly in development. Grammar initialization is a later optimization given the isolation result.

This was the implementation order proposed by the initial investigation. The follow-up above implements steps 1 through 4 of this detailed list (the three user-facing priorities), and records their measurements. No milestone changes or startup import splitting were made.

## Reproduce

```powershell
# Builds the application, then runs five fresh processes against a snapshot.
npm run bench:app-startup

# After the build, collect the scenarios used above.
node scripts/bench-app-startup.mjs --rounds=3 --skip-build --output=out/bench-app-startup/baseline.json
node scripts/bench-app-startup.mjs --rounds=3 --skip-build --largest-session --output=out/bench-app-startup/largest.json
node scripts/bench-app-startup.mjs --rounds=3 --skip-build --dev --output=out/bench-app-startup/dev.json
node scripts/bench-app-startup.mjs --rounds=3 --skip-build --dev --largest-session --output=out/bench-app-startup/dev-largest.json
node scripts/bench-app-startup.mjs --rounds=3 --skip-build --largest-session --variant=no-react-resize --output=out/bench-app-startup/no-react-resize.json
node scripts/bench-app-startup.mjs --rounds=3 --skip-build --largest-session --variant=no-highlight --output=out/bench-app-startup/no-highlight.json

# An empty application profile; no real settings or database are copied.
node scripts/bench-app-startup.mjs --rounds=1 --skip-build --empty
```

`--source-data=<directory>` selects another Gloss data directory; the default on Windows is `%APPDATA%/gloss`. The diagnostic bundle edits require the current readable Electron Vite build and deliberately fail if their target no longer matches. Development mode uses a local Vite server with the repository's React plugin and source aliases, plus the built main and preload. It is a renderer-development comparison, not an end-to-end timing of the `npm run dev` command.

## Method and limits

- Use SQLite's backup API from a read-only connection to snapshot the source database outside the timed interval. Copy settings without printing their contents. Each process receives a fresh temporary user-data directory. The original Gloss database and settings are never opened for writing by the benchmark.
- `--largest-session` reorders the session-list response to select the conversation with the most message text. It does not modify the database's history or timestamps. Background agent refresh still follows normal application behavior, so the native transcript can update the copied cache. Each result records restored message/tool counts.
- Native agent credentials, configuration, startup hooks and MCP behavior are inherited. Session restore, external-session discovery and Git/PR checks run as usual. The benchmark sends no prompts and makes no model inference requests. Normal application teardown disposes connections.
- Start the timer immediately before spawning Electron. Build, snapshot preparation and Vite-server creation are excluded. Initial browser navigation and renderer resource loading are included. Main module, window creation, window show and DOM readiness are recorded separately.
- Register buffered long-task observation, frame timestamps and a composer DOM observer through the Chromium debugger. Record the first animation callback after the composer appears as `composerMs`. This is a first-frame proxy, not a measured hardware input-to-paint latency or a guarantee that the window has already been presented; use `windowShownMs` alongside it. This investigation does not claim a sub-100-ms responsiveness result.
- Observe startup for approximately ten seconds after main initialization. CPU sampling and debugger instrumentation are enabled in every case and add overhead. The latest development sample with the initial loading outlier consequently has less observation time after its composer appeared.
- Then make 120 native `setSize` calls, requesting 16 ms spacing, over the same sinusoidal width range (about 920 to 1,280 pixels) at 820 pixels high. Actual sweeps took roughly 3.8 to 4.7 seconds. Record frame intervals, long tasks, renderer JavaScript time and layout metrics. These are scripted native resizes; manual border dragging, pane-handle dragging, and resizing during a streaming turn are not measured.
- Fresh user-data directories include fresh Chromium caches and default local UI layout state. OS and Vite caches remain intact. Another Gloss instance was open during measurement. Experiments ran sequentially, with three samples per case, so small differences and absolute timings should be treated as exploratory. There is no controlled post-reboot startup measurement or exhaustive history-size scaling study.

Validation: built the application successfully, ran all 18 recorded profiles and the empty-profile smoke check, and checked benchmark JavaScript syntax, targeted lint and whitespace. The new benchmark does not change application runtime code.
