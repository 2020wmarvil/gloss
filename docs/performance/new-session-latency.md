# New-session latency investigation

Measured October 25, 2026 on Windows 11, Intel i9-12900KS, Electron 44.7.0 / Node 24.21.0. Installed ACP adapters: Claude 0.89.1 and Codex 2.2.2. These measurements precede the immediate-composer change described below.

## Immediate composer

New Session now creates a local conversation and opens its composer while agent attachment runs in the background. Messages submitted during startup use the existing turn path, which waits for attachment and configuration before prompting. The conversation keeps its identity as the native agent session becomes ready, preserving focus and drafts. Startup failures preserve the conversation and a subsequent send can retry; pending local sessions can also attach after restarting Gloss.

The benchmark below continues to measure backend readiness through `createSession`. It does not measure the new local `startSession` path or click-to-composer latency. No prepared-session pool was added.

## Reproduce

```powershell
npm run bench:new-session

# Use the current project's real Gloss settings, including its MCP servers.
node scripts/bench-new-session.mjs --rounds=10 "--settings=$env:APPDATA/gloss/settings.json" --output=out/bench-new-session/baseline.json

# Investigate Claude's supported effort-at-creation metadata.
node scripts/bench-new-session.mjs --agents=claude --rounds=10 --claude-creation-effort=medium "--settings=$env:APPDATA/gloss/settings.json" --output=out/bench-new-session/creation-effort.json
```

Other options: `--cwd=<absolute-project-path>`, `--agents=claude,codex`, and `--timeout-ms=90000`. Without `--settings`, the benchmark uses Gloss's bypass default and no Gloss-configured MCP servers. Native agent credentials and native user/project configuration are inherited in both cases. Run from the repository root after `npm install`.

The launcher bundles the actual `SessionManager`, `AgentConnection`, SQLite store and shared instructions, then runs them with Electron's Node runtime, like the app. Build time and database initialization are outside the measured interval. The database lives in a new temporary directory; the benchmark does not open Gloss's database or send prompts, run inference, or start interactive authentication. Agent startup hooks and MCP startup still follow native configuration. Only the benchmark's newly created empty sessions are closed/deleted afterward. Empty Claude sessions are verified absent from the agent's listing after close because their transcripts are not written until a prompt. Raw diagnostics and settings contents are excluded from output.

Each round measures the first session on a fresh adapter process/connection (**cold**), then a new session on that same connection with the first session still attached (**warm**). Agent order alternates between rounds. Cold here means process-cold, with OS caches and existing authentication intact. These are not post-reboot or first-install measurements. The first exploratory run before these repeatable rounds observed Claude at 3.88 seconds, so process-cold medians should not be treated as worst-case cold latency.

The timer covers `createSession` through configuration and attachment, followed by `openSession`'s local snapshot. Phase timings separate connection startup, `session/new`, permission mode, effort and snapshot creation. It excludes renderer/IPC latency, first paint, first model response and completion of any deferred MCP startup. Thus it measures backend session readiness, not the full click-to-interactive-composer interval. Background refresh triggered by `openSession` is not awaited, matching the app.

JSON contains every sample, setup failures, environment metadata, final mode/effort, phase durations and nearest-rank p50/p95 summaries. Failures produce a nonzero exit code and a failed cold start skips its invalid warm counterpart. Compare results on the same machine, project, configuration and versions. Ten samples per category are exploratory; their p95 is simply the largest observation.

## Baseline

Forty successful samples, ten per agent/start category, using this project's current Gloss settings: bypass permissions and one Gloss-configured MCP server. No cleanup warnings. Raw data: [baseline.json](new-session-baseline.json).

| Agent | Cold p50 | Cold range | Warm p50 | Warm range |
| --- | ---: | ---: | ---: | ---: |
| Claude | 1,016 ms | 968-1,077 ms | 684 ms | 630-857 ms |
| Codex | 714 ms | 668-1,043 ms | 175 ms | 156-186 ms |

Median phase durations (individual medians need not sum to the total median):

| Agent/start | Connect + initialize | session/new | Permission mode | Effort |
| --- | ---: | ---: | ---: | ---: |
| Claude cold | 291 ms | 634 ms | 28 ms | 49 ms |
| Claude warm | reused | 587 ms | 29 ms | 51 ms |
| Codex cold | 188 ms | 495 ms | 1 ms | no request |
| Codex warm | reused | 169 ms | <1 ms | no request |

Local snapshots took less than one millisecond. The dominant warm cost is still creating an agent session, especially for Claude. Warming only the ACP connection leaves that cost on the click path. Codex's first `session/new` also starts/initializes its native app server, so its connection timing alone understates cold startup work.

## Creation-time settings experiment

Claude's installed adapter accepts `_meta.claudeCode.options.effort`. A benchmark-only variant supplied `medium` at creation, matching the baseline's resulting effort. All twenty resulting sessions reported medium effort and bypass permission mode; none issued a follow-up `setConfigOption` request. Raw data: [creation-effort.json](new-session-creation-effort.json).

| Claude | Baseline p50 | Effort at creation p50 | Observed reduction |
| --- | ---: | ---: | ---: |
| Cold | 1,016 ms | 978 ms | 37 ms |
| Warm | 684 ms | 627 ms | 56 ms (8%) |

This is a sequential experiment, so differences include run-to-run noise. Eliminating the effort request is directly observed; attributing the entire median reduction to it is an inference. The baseline effort request itself cost about 50 ms. Production would need to preserve the current model-dependent choice rather than unconditionally force medium: `concreteEffort` chooses medium only for an agent-reported default, or another supported concrete level if medium is unavailable.

Permission mode cannot be folded into the same metadata without adapter work: Claude's `createSession` spreads user-provided options, then explicitly overrides `permissionMode` with its own resolved initial mode. Its internal `creationOpts.permissionMode` is not exposed through `session/new`. Codex takes its initial mode from the process-wide `INITIAL_AGENT_MODE` environment variable, not a per-session setting. Gloss shares a connection across projects with different permission defaults, and its measured mode request is already below a millisecond. Changing process-wide defaults is therefore a poor substitute for per-session configuration here.

Source inspection: Gloss's `src/main/sessions.ts` (`createSession`, `applyMode`, `attached`, `concreteEffort`); installed Claude `dist/acp-agent.js` (`createSession`, SDK option construction and effort seed); installed Codex `dist/index.js` (`AgentMode.getInitialAgentMode`, `CodexAcpClient.newSession`, `tryCreateSession`). These conclusions apply to the recorded adapter versions.

## Prepared-session feasibility

A prepared spare can move session creation and configuration off the click path, including the approximately 684 ms Claude / 175 ms Codex warm path measured here. Those numbers describe work that could move into the background, not measured acquisition speed or a promised user-visible improvement. A pool/acquisition implementation has not been built or timed.

Claude's adapter calls SDK `query()` during session creation and awaits `initializationResult()`, leaving a live native CLI per prepared session. Codex shares an app server across sessions and creates another thread. Both can therefore hold an initialized empty session, but Claude has a larger likely resource cost. Memory, idle CPU, background network behavior and first-prompt correctness still need measurement before selecting a policy.

The next useful prototype is one hidden spare for the selected agent and active project. Claim it atomically, keep it on its existing connection, then replenish after acquisition. A mismatch or unavailable spare must fall back to the current path. Its identity must cover cwd, agent/profile, instructions, MCP configuration and permission defaults, with invalidation for changed native/project configuration and closed connections. Unused spares need explicit cleanup and must not appear as real Gloss sessions. Native agent session-list visibility also needs checking: merely hiding a row in Gloss's database is insufficient.

Measure spare-hit versus spare-miss latency, refill interference with an active turn, idle process/memory cost, stale configuration rejection, and whether the first prompt uses the intended instructions, mode and tools. Those tests would decide whether the saved startup time justifies retaining a spare. No milestone edits or pooling decisions were made in this investigation.
