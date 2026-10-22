# Custom ACP profiles

M14 design: Settings > Agents contains the guided OpenCode setup followed by Custom ACP agents. Compact rows show each agent's name, executable name and a neutral Default label where applicable. Clicking a row opens its editor; a trailing action menu contains Remove. Add agent sits beside the section heading, and an empty list has a short empty state. Internal IDs stay out of the list.

The editor replaces the list and uses the same cards and labeled fields as other settings. Name, executable and arguments appear first; Advanced holds the immutable profile ID, instruction environment variable and environment references. New IDs are generated from the name and avoid existing IDs, with a manual override under Advanced. All agents and Cancel return without saving, restoring focus to the originating row or Add button. Edits preserve list order. The one primary action, Test and save, initializes ACP before saving. A compact success message offers expandable Connection details with readable capability labels. Testing creates no conversation and calls no model. Launch errors identify missing executables, missing environment variables, incompatible ACP and initialization timeouts without displaying raw agent diagnostics. The list and editor use existing light/dark tokens and fit a 720px window.

IDs use `custom:<name>` and remain fixed while editing. Removing a profile preserves its conversations. Those conversations remain readable and show a recovery notice asking to restore the same ID. Removing the default resets the default to Claude Code. Running turns finish before changed or removed profiles disconnect.

Environment references map child variable names to variables in Gloss's inherited environment, never credential values. Agents retain their native credential stores. Arguments are passed directly, without shell evaluation. On Windows, choose a native executable rather than a command wrapper.

ACP does not standardize system-instruction delivery. A profile must use its agent's documented instruction-file argument with `{instructions}` in the argument array, or name an environment variable that accepts an instruction-file path. Gloss writes the file in its own data directory. The connection test verifies ACP compatibility, not instruction semantics or coding quality. Only the guided OpenCode integration is presented as tested. Other profiles require a compatible agent or wrapper that reads this file.

Capabilities appear in connection results: resume, discovery, images, embedded context and steering. Unsupported controls keep their existing capability gates. If an agent cannot load a previous session, opening it retains the transcript and explains that the user must create a new conversation. Gloss never silently starts a replacement with lost context.

Local models remain configured in OpenCode. Settings links to the Ollama recipe; model downloads, inference-server management and automatic hosted fallback are outside M14.

## Setup example

The flag below is illustrative. Replace it with your agent's documented instruction-file argument; ACP itself does not define this flag. For agents that only discover project instruction files, use an agent-specific wrapper that accepts the Gloss file without editing the project.

```json
{
  "agentProfiles": [{
    "id": "custom:my-agent",
    "name": "My agent",
    "command": "/absolute/path/to/agent",
    "args": ["acp", "--instructions-file", "{instructions}"],
    "env": { "API_KEY": "MY_AGENT_API_KEY" }
  }]
}
```

The child receives `API_KEY` from Gloss's inherited `MY_AGENT_API_KEY`; the credential value is never stored in this profile. Alternatively set `instructionsEnv` to the documented variable that accepts an instruction-file path, and omit the instruction-file argument. Restart Gloss after changing its inherited environment. Native credential stores need no environment references.

### OpenCode as a custom profile

`scripts/opencode-custom-acp.mjs` is a working wrapper for trying the custom-profile flow with an installed OpenCode executable. Copy it into Gloss's data directory under `agent-wrappers`, set the profile's executable to your native Node executable, and use arguments `["<wrapper-path>", "<native-opencode-path>", "{instructions}"]` with an empty environment-reference object. The wrapper appends the Gloss instruction file to OpenCode's inline configuration and preserves existing providers, models and instructions. It uses the same native OpenCode credentials and models as the guided setup. The extra profile demonstrates custom ACP setup; it does not install another agent or model.

## Verification

- `npx vitest run src/main/agentProfiles.test.ts` runs a real Node ACP subprocess. It verifies configuration persistence, environment references, instruction delivery, protocol/version diagnostics, capability differences, thread routing, tool events and a file edit, cancellation, restart/replay, and removal/restoration with history retained. It makes no model calls or network requests. The fixture is included in the Windows and Linux CI matrix.
- `npx vitest run src/renderer/src/AgentProfileSettings.test.tsx` verifies successful-test-before-save, failed connection feedback, capability results, stable IDs and default-profile removal.
- `npm test`, `npm run typecheck`, `npm run lint` and `npm run build` cover regressions across existing agents.
- Real Windows OpenCode v2.0.32 passed streamed replies, instruction delivery, threads, file edits, cancellation and process restart against a local mock provider. Ollama 0.40.5 with `qwen3.5:latest` also passed a response and a native write-tool call at 64K context on an RTX 3080 12 GB with 64 GB RAM. See `OPENCODE.md` for repetition instructions.

Linux runtime smoke testing with an installed OpenCode executable remains outstanding. The local WSL distribution has neither Node nor OpenCode installed. The Windows local-model check removed hosted credentials and denied hosted providers; it did not enforce an OS network sandbox. Interactive provider authentication and external MCP servers retain the existing manual-validation limitations. No hosted fallback was used.
