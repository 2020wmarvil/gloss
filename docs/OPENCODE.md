# OpenCode support

Gloss supports a user-installed OpenCode v2 executable over ACP. OpenCode manages its own providers and models, including local Ollama models. Custom ACP profiles are also available in Settings > Agents; see [profile setup](ACP-PROFILES.md). Inference-server management remains outside Gloss.

## Setup and use

- **New session:** OpenCode appears beside Claude Code and Codex, with the same default-agent star. Sessions retain their agent when another agent becomes the default.
- **Setup:** an OpenCode section in Settings offers an executable path, Test connection, a detected version and a connection result. Use an installed native executable or find it on PATH. Show install/configuration links when missing. Keep OpenCode unavailable for new sessions until the connection check succeeds.
- **Providers:** explain that OpenCode runs the coding task and its selected model may be hosted or local. Use its native provider setup initially. For local inference, link a tested Ollama recipe. Connecting OpenCode alone does not mean a local model is installed or running.
- **Conversation:** the existing streamed replies, tool rows, thread panel, cancellation, model picker and review UI remain the main interaction. Populate controls from advertised capabilities and config options. No separate local-model chat screen.
- **Recovery:** a missing executable or stopped model server has an actionable error. Retain conversations and never switch them to a different agent or hosted provider automatically.

Open Settings > Agents, find OpenCode, and click **Test connection and save**. Leave the executable path empty for automatic discovery, or supply the native executable path. Windows discovery includes OpenCode Desktop's versioned CLI directory. On macOS and Linux, use PATH or an explicit native executable path. Windows `.cmd`, `.bat` and PowerShell wrappers are rejected; no shell is used to launch the agent.

Once connected, choose OpenCode from the New session menu, or star it as the default. Pick the desired model in the status line before sending a prompt. OpenCode's native default determines the initial model; Gloss does not choose a hosted provider on your behalf. The connection test initializes ACP without creating a session or calling a model. Tests are cached briefly; the Settings button always performs a fresh test.

For local inference, install/update Ollama, download a tool-capable model and keep Ollama running. OpenCode v2 discovers available completion models through Ollama's API. Ollama model files remain managed by Ollama. Use a context window of at least 64K, as required by the [Ollama OpenCode guide](https://docs.ollama.com/integrations/opencode). Check active context and processor split with `ollama ps`. A 4K context produced chat replies but lost tool instructions in validation; 64K completed the same file-writing task. Larger context windows require more memory.

Gloss appends its thread and diff-tag guidance through a Gloss-owned `opencode-instructions.md` in its data directory, supplied via `OPENCODE_CONFIG_CONTENT.instructions`. It preserves native config files and existing inline providers, models and instruction paths. Existing inline content must be valid JSON; native files can use JSONC. No project instruction files or hidden user messages are created. The instructions also explain that skill descriptions mentioning Codex do not identify the selected model.

OpenCode's available models, effort choices, attachments and tool events use the same ACP paths as the other agents. Unsupported steering stays unavailable and follow-ups queue normally. OpenCode has no bypass mode, so the status line's mode picker offers **Approve requests automatically** (on by default with the `bypass` permission setting); turn it off to answer each request yourself. OpenCode's native deny rules are still its own responsibility. Plan-subscription usage is unavailable for OpenCode. Provider authentication uses OpenCode's native terminal flow when it advertises an ACP terminal method.

An executable change restarts an idle OpenCode connection; active prompts finish first. Sessions keep their agent, model selection, working directory and thread history. Connection failure does not switch a session to another agent.

## Verified with the executable

Windows x64, OpenCode Desktop's bundled CLI `2.0.32`, Gloss's installed `@agentclientprotocol/sdk@1.8.0`:

| Check | Result |
| --- | --- |
| Native executable launched directly with `acp` | Pass |
| ACP initialize and protocol version | Pass, version 1 |
| Create session in a temporary project | Pass |
| Discover the created session with `session/list` | Pass |
| Close, then load that session | Pass |
| Config options | Model and mode |
| Advertised prompt capabilities | Images and embedded context |
| Advertised MCP transports | Stdio (protocol baseline) and HTTP; SSE unavailable |
| Advertised session capabilities | Load, list, close, delete, fork and resume |
| Gloss steering extension | Not advertised |
| Session deletion | Advertised |
| Modern terminal sign-in with Gloss's current initialize request | Terminal method, `acp --login` |
| Missing executable | Clean failure during launch, exit code 1 |

The no-inference probe sends no prompts. A separate opt-in integration test runs the real v2 executable against a local mock model endpoint. It verifies native instruction delivery, model selection, streamed output, a file write and tool events, thread replies, populated-history replay across process restarts, and cancellation. Test configuration and data live in temporary directories; hosted providers are denied. Linux and macOS runtime behavior, interactive provider authentication and external MCP servers still need manual validation.

A live smoke test also passed with Ollama `0.40.5` and the installed `qwen3.5:latest`, on an RTX 3080 12 GB with 64 GB RAM. It used temporary native configuration, disabled background title generation, bounded response length and disabled thinking. The M14 recheck passed both a short response and a native write-tool call creating `local-proof.txt` with the expected contents, using 65,536 tokens of context and a 512-token output limit. At 4,096 context the installed model answered chat but did not call the tool. The 64K test model occupied 7.7 GB on the GPU. This verifies a small local coding loop, not coding quality or performance with a full repository and skills catalog. The test server was started temporarily with its context set in its process environment, then stopped and its model unloaded. No native configuration files or persistent Ollama settings were changed.

## Repeat the probe

After installing a native OpenCode executable:

```powershell
npm run probe:opencode -- C:/path/to/opencode.exe
```

On Linux, pass its executable path, or omit the argument to resolve `opencode` on PATH. The script creates temporary configuration, data and project folders and removes them after the process exits. Its only model is a dummy provider at an unreachable loopback endpoint; it never sends `session/prompt`. It does not install an agent or download a model. This isolates credentials and configuration, but does not enforce a network sandbox.

Run the real-process integration test on Windows:

```powershell
$env:GLOSS_OPENCODE_EXECUTABLE = 'C:/path/to/opencode.exe'
npx vitest run src/main/opencode.integration.test.ts
```

Set `GLOSS_OPENCODE_LIVE_OLLAMA=1` as well to opt into the local Qwen smoke test. It requires an already downloaded `qwen3.5:latest` and running Ollama with at least 64K context, denies hosted providers, uses temporary OpenCode data, requests a short response, and verifies a tool call and file edit. Tests remove hosted credentials from the child environment and deny hosted providers, but do not enforce an OS network sandbox. Normal test runs skip both executable-dependent checks.

## Local test-server context

If you manage Ollama through a terminal, stop its existing server first and start it with a 64K context in that terminal:

```powershell
$env:OLLAMA_CONTEXT_LENGTH = '65536'
ollama serve
```

Keep the server running and run the opt-in tests from another terminal. This variable applies to that server process. If Ollama is managed by its desktop app or a service, configure context through that installation instead. Gloss does not start or reconfigure Ollama. A loopback URL such as `http://127.0.0.1:11434` addresses this computer; LAN or hosted addresses send requests to another machine. Agent tools and MCP integrations can still use the network even with local inference.

## Primary references

- [Provider configuration, including Ollama](https://dev.opencode.ai/v2/docs/providers/)
- [Configuration](https://dev.opencode.ai/v2/docs/config/) and [instruction files](https://dev.opencode.ai/v2/docs/instructions/)
- [Pinned ACP service source, v2.0.32](https://github.com/anomalyco/opencode/blob/v2.0.32/packages/cli/src/acp/service.ts)
- [Pinned license](https://github.com/anomalyco/opencode/blob/v2.0.32/LICENSE)

The original compatibility spike tested v1.19.3. That release has different authentication and MCP capabilities and is not supported by this integration. Recheck behavior when updating the supported v2 release.
