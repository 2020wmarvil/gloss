# OpenCode integration spike

Status: compatibility investigation on `feat/opencode-agent`. OpenCode is not yet selectable in Gloss. This is the first slice of the proposed open source/local-agent milestone, brought forward at the user's request.

## How it should look in Gloss

- **New session:** OpenCode appears beside Claude Code and Codex, with the same default-agent star. Sessions retain their agent when another agent becomes the default.
- **Setup:** an OpenCode section in Settings offers an executable path, Test connection, a detected version and a connection result. Use an installed native executable or find it on PATH. Show install/configuration links when missing. Keep OpenCode unavailable for new sessions until the connection check succeeds.
- **Providers:** explain that OpenCode runs the coding task and its selected model may be hosted or local. Use its native provider setup initially. For local inference, link a tested Ollama recipe. Connecting OpenCode alone does not mean a local model is installed or running.
- **Conversation:** the existing streamed replies, tool rows, thread panel, cancellation, model picker and review UI remain the main interaction. Populate controls from advertised capabilities and config options. No separate local-model chat screen.
- **Recovery:** a missing executable or stopped model server has an actionable error. Retain conversations and never switch them to a different agent or hosted provider automatically.

These are proposed flows. The executable test and runtime integration still need implementation before exposing OpenCode in the menu.

## Verified with the executable

Windows x64, OpenCode `1.19.3` (the `opencode-windows-x64` npm package), Gloss's installed `@agentclientprotocol/sdk@1.8.0`:

| Check | Result |
| --- | --- |
| Native executable launched directly with `acp` | Pass |
| ACP initialize and protocol version | Pass, version 1 |
| Create session in a temporary project | Pass |
| Discover the created session with `session/list` | Pass |
| Close, then load that session | Pass |
| Config options | Model and mode |
| Advertised prompt capabilities | Images and embedded context |
| Advertised MCP transports | Stdio (protocol baseline), HTTP and SSE |
| Advertised session capabilities | Load, list, close, fork and resume |
| Gloss steering extension | Not advertised |
| Session deletion | Not advertised |
| Modern terminal sign-in with Gloss's current initialize request | No terminal method supplied |
| Missing executable | Clean failure during launch, exit code 1 |

The probe sends no prompts. It does not establish tool execution, response streaming, cancellation, populated-history replay, resume across process restarts, inference, Linux support or Ollama compatibility. Advertised capabilities still need functional verification. No hosted credentials or user configuration are passed into the subprocess.

## Repeat the probe

After installing a native OpenCode executable:

```powershell
npm run probe:opencode -- C:/path/to/opencode.exe
```

On Linux, pass its executable path, or omit the argument to resolve `opencode` on PATH. The script creates temporary configuration, data and project folders and removes them after the process exits. Its only model is a dummy provider at an unreachable loopback endpoint; it never sends `session/prompt`. It does not install an agent or download a model. This isolates credentials and configuration, but does not enforce a network sandbox.

## Integration details to resolve

1. **Instruction delivery:** the pinned OpenCode ACP `session/new` and `session/load` implementations do not consume Gloss's Claude/Codex `_meta` instruction fields. Investigate a Gloss-owned instruction file supplied through OpenCode's supported configuration, without touching project instruction files or replacing native instructions. Verify config merging, path handling, CLI visibility and review-session instructions. Do not insert hidden user turns, which would interfere with transcript matching.
2. **Authentication:** the pinned source gates its older terminal-auth metadata on `clientCapabilities._meta["terminal-auth"]`. Gloss currently advertises `clientCapabilities.auth.terminal`. Either bridge this extension deliberately with a tested executable/argument policy or present native provider setup outside the existing sign-in dialog. Do not assume a successful `authenticate` request performed an interactive login.
3. **Launch and lifecycle:** add a configurable executable and bounded connection test. Windows npm `.cmd` shims are different from a directly spawnable native `.exe`; keep arguments structured and avoid a shell. Test missing executables, process exits, restart and session replay.
4. **Permissions:** OpenCode's model/mode config options are not evidence of a bypass session mode. Confirm the actual permission requests and explain the effective behavior under Gloss's current permission policy.
5. **Coding and local inference:** first verify streamed output, a file edit, cancellation and history replay with a configured provider. Then exercise a tool-capable model served by Ollama, including server-down errors and an offline run. Report model, runtime and hardware used.
6. **Existing integrations:** generalize the default-agent enum, selector and any agent-specific labels; gate usage/cost, skills, plugins and native MCP imports by actual support. Preserve existing Claude Code and Codex sessions.

## Primary references

- [OpenCode ACP documentation](https://opencode.ai/docs/acp/)
- [Provider configuration, including Ollama](https://opencode.ai/docs/providers/)
- [Configuration and instruction files](https://opencode.ai/docs/config/)
- [Pinned ACP service source, v1.19.3](https://github.com/anomalyco/opencode/blob/v1.19.3/packages/opencode/src/acp/service.ts)
- [Pinned license](https://github.com/anomalyco/opencode/blob/v1.19.3/LICENSE)

Recheck release behavior when implementing. The development branch has a different source layout from the tested release.
