# M19 phase 1 handoff

Implementation was paused at the user's request. This handoff was recreated after the original file disappeared. The feature is not complete or ready to merge.

## Important: recover the working tree before resuming

Current filesystem and Git checks:

- Main checkout: `C:\Users\YDOG\Desktop\gloss`, on `dev`, currently at `0e390fb`.
- Feature branch: `m19-custom-plugins` still exists at its original base, `6e804e4` (`Polish the annotation window`). No implementation commits were made before the pause.
- Implementation folder: `C:\Users\YDOG\Desktop\gloss-m19-custom-plugins` still contains all implementation source/test files listed below.
- That folder no longer has a `.git` file and no longer appears in `git worktree list`. Its `docs` files, including the original handoff, are missing. The cause has not been established.
- Do not assume that folder is a functioning Git worktree. Do not run reset, clean, checkout, or a new worktree creation over the remaining files.

Before resuming, preserve the listed source files outside the checkout. A safe recovery approach is to create a clean worktree at a new unused path on the **existing** `m19-custom-plugins` branch, then copy only the implementation files listed below into it. The base is still `6e804e4`, so those files reconstruct the previous uncommitted change. Restore the current phase plan from the main checkout's `docs/MILESTONES.md`. Do not overwrite ongoing `dev` work. Reconcile with newer `dev` changes separately after recovery.

The implementation folder's `node_modules` is a junction to the main checkout's `node_modules`. Do not recursively copy that directory or modify shared dependencies casually. Use an independent installation if dependency changes become necessary.

## User preferences and scope

- The user explicitly authorized a separate branch/worktree for this feature, so it can run alongside other dev work. This overrides their normal rule to work on `dev` and not create branches.
- Never add Co-Authored-By or Codex attribution to commits. Do not use em dashes in prose.
- The user objected to repository clutter from scratch research, spike scripts and images. Keep exploratory files and screenshots under `%TEMP%`. Actual implementation modules and meaningful tests are appropriate.
- Do not spawn subagents unless subsequently authorized. The earlier research subagents are completed and unrelated to this implementation.
- Implement **M19 phase 1 only** and stop for review. Phase 2 is plugin import; source ownership and moving existing skills are deferred. Phase 3 is catalog discovery. Upstream updates are a separate exploratory milestone.

## Agreed product design

Plugins are the top-level library entries. A personal plugin can contain just one skill or several related skills, supporting files and supported MCP connection references. No marketplace, publication, upstream provenance, version management or update subscription is required.

The approved mock was simplified:

- No Discover tab, imports, manage-existing actions or marketplace metadata in phase 1.
- No agent matrix in the library list. Availability controls live only in the selected plugin's Agents tab.
- No redundant footer labels or generic repeated explanations.
- New plugin opens creation directly.
- Nested skill editing, supporting files, shared connections, custom-agent setup and removal are included.
- Support Claude Code, Codex, OpenCode and compatible custom ACP profiles, with honest support limits.
- Preserve existing native skills and configuration. Phase 1 does not move or take ownership of them.

The mock and previews were confirmed to still exist after this handoff was recreated:

- Current interactive phase-1 mock: `C:\Users\YDOG\Desktop\gloss\docs\mocks\plugins.html` (ignored local file in the main checkout).
- Saved previews: `C:\Users\YDOG\AppData\Local\Temp\gloss-plugin-previews`.
- The mock copy under `gloss-m19-custom-plugins/docs/mocks` is missing.

Use the main-checkout mock for visual comparison when resuming. Keep it local/ignored and keep screenshots outside the repo. Temporary previews may be cleaned by the OS; the HTML mock is the design reference.

## Implementation files to preserve and restore

All these files were checked and still exist under `C:\Users\YDOG\Desktop\gloss-m19-custom-plugins` when this handoff was recreated.

Modified files relative to `6e804e4`:

```text
src/main/index.ts
src/main/sessions.ts
src/preload/index.ts
src/renderer/src/SettingsScreen.tsx
src/renderer/src/styles.css
src/shared/ipc.ts
```

New implementation and tests:

```text
src/shared/plugins.ts
src/main/plugins.ts
src/main/plugins.test.ts
src/main/plugins.integration.test.ts
src/renderer/src/PluginSettings.tsx
src/renderer/src/PluginSettings.test.tsx
```

`docs/MILESTONES.md` had also been changed to record the three phases. It survives in the main checkout, but is missing from the implementation folder. `docs/SPEC.md` had not yet been updated for this feature.

## Architecture

### Library service: `src/main/plugins.ts`

`PluginLibrary` is independent of Electron. Data lives under `<userData>/plugins`:

```text
plugins/
  library/<plugin-id>/
    plugin.json
    skills/<plugin-id>-<skill-name>/
      SKILL.md
      references/...
      scripts/...
  runtime/claude/<plugin-id>/.claude-plugin/plugin.json
  runtime/claude/<plugin-id>/skills/<skill-id>
  runtime/codex/.agents/skills/<skill-id>
  runtime/opencode/skills/<skill-id>
  state.json
```

- `plugin.json` is a Gloss-local schema, not a claim of universal Agent Plugins compliance. Fields: `schemaVersion: 1`, `name`, `description`, `connections` (global MCP names), `enabledAgents`.
- Stable plugin IDs derive from names. New skills use namespaced folder/frontmatter IDs to avoid collisions.
- Ordinary authoring files are authoritative. A recursive watcher detects external edits, reconciles deployments and requests refresh only for affected agents.
- UI writes include a content-hash revision and refuse to overwrite a file changed since opening it.
- Paths reject traversal and source symlink escapes. Current limits: 1 MB text editing, 64 MB per plugin/deployment, 1,000 files. Skill frontmatter requires a matching name and single-line description; multiline YAML descriptions are not supported yet.
- Deployment records track exact agent/plugin/source/target, link or copy mode, and a content hash. Copy fallback preserves diverged target files. Pre-existing deployment targets are refused.
- State paths and target parents are checked. Corrupt state, unexpected replacements and redirected targets are surfaced rather than overwritten.
- Busy agents keep their deployments until idle. Removing plugins or skills used by active turns is refused.
- Native hooks, native agents/commands, embedded MCP server files and native entrypoint scripts are not loaded in this implementation. Such components produce a visible problem. The mock's hook states were illustrative, not verified implementation promises.

### Native delivery

These paths passed real-adapter tests using a loopback model stub:

- Claude: generated local native plugin projection through `_meta.claudeCode.options.plugins` on session new/load. Existing thread instructions are preserved.
- Codex: scoped `.agents/skills` projection through `_meta.additionalRoots`. The installed ACP adapter calls its native extra-skill-roots API. This avoids changing the user's `.codex/skills` or registering a marketplace. It is component mapping, not native marketplace installation.
- OpenCode: merge the runtime skills root into `OPENCODE_CONFIG_CONTENT.skills`, preserving native provider, instruction and skill configuration. No native config files are rewritten.
- Custom profiles: explicitly configured private skill directory, receiving Gloss-owned namespaced links/copies. Support is labeled user-configured. An OpenCode-based custom example was tested. Standard stdio MCP is supported through ACP; remote MCP transports for arbitrary custom profiles are currently reported unverified.

MCP definitions stay in M13's global list. Plugins reference them as requirements. Removing a reference or plugin does not delete a connection. Global connections remain independently available even after a plugin is disabled. The UI labels them **Configured**, not Connected, because settings alone do not establish authentication or runtime status.

### Integration

- `src/shared/plugins.ts`: manifest, snapshot, file and API types.
- `src/shared/ipc.ts`: channels, API and `pluginsChanged` event.
- `src/preload/index.ts`: `window.gloss.plugins` methods.
- `src/main/index.ts`: initialization, IPC, agent-config decoration and queued refresh. `refreshPlugins` / `applyPluginChanges` use revision numbers and `SessionManager.restartIdleAgent(id, true)`; turn-end retries pending refreshes.
- `src/main/sessions.ts`: `isAgentBusy(agentId)`.

### Renderer

- `PluginSettings.tsx`: searchable plugin list, Overview/Skills/Tools/Agents details, Markdown/file inspection, editor, new plugin/skill/file forms, shared-connection picker, custom skill-directory setup, deletion and refresh.
- Unsaved drafts are guarded when switching details or leaving Settings. A concurrent-save rejection keeps the draft.
- `SettingsScreen.tsx`: Plugins navigation, layout and navigation guard. Settings-file path/editor controls are hidden in the plugin section.
- `styles.css`: styles appended at the end, based on the mock. The actual built app still needs visual verification.

## Validation at the pause

These results are historical and must be revalidated after worktree recovery:

- Backend: 15 tests passed after the latest safety changes.
- Plugin UI: 6 tests passed; the existing SettingsScreen test also passed.
- Latest combined backend + plugin UI run: 21 tests passed.
- Native integration: 4 tests passed for Claude, Codex, OpenCode and a custom OpenCode configuration. Real adapters loaded plugin skill bodies and advertised a local stdio MCP tool. Claude/OpenCode read a supporting file using native tools. Disabling the plugin removed its skill while preserving the global MCP tool.
- Codex supporting-file shell execution is not tested by the stub because its automatic reviewer needs a structured assessment. No approval bypass was added.
- Typecheck passed before the final small backend changes; the last build also advanced past typecheck into Vite.
- One known lint failure: `src/main/plugins.integration.test.ts`, around line 123, `no-unsafe-finally`. Cleanup-path validation throws inside `finally`; move validation outside it or into an appropriate helper without masking the original test failure.
- A build was launched, but its final exit status was not captured. `out` artifacts exist. Do not claim final build success without rerunning.
- Full repository tests have not been run for this change.

The embedded MCP fixture initially had incorrect escaping; it was fixed using `String.raw`. OpenCode warms MCP discovery asynchronously, so the integration test makes bounded additional local prompts after restart. Assertions use booleans rather than dumping full provider context.

## Resume commands

After restoring a registered feature worktree, run from its root:

```powershell
git status --short --branch
npx --no-install vitest run src/main/plugins.test.ts src/renderer/src/PluginSettings.test.tsx src/renderer/src/SettingsScreen.test.tsx
npm run typecheck
npm run lint
npm run build
```

Native tests:

```powershell
$env:GLOSS_PLUGIN_NATIVE = '1'
$env:GLOSS_OPENCODE_EXECUTABLE = 'C:/Users/YDOG/AppData/Roaming/ai.opencode.desktop/cli/2.0.32-x64/opencode-cli.exe'
npx --no-install vitest run src/main/plugins.integration.test.ts
Remove-Item Env:GLOSS_PLUGIN_NATIVE
Remove-Item Env:GLOSS_OPENCODE_EXECUTABLE
```

Verify the executable still exists before using that path. Tested versions were Claude ACP 0.89.1 with SDK-bundled Claude 2.1.293, Codex ACP 2.2.2 with CLI 0.160.1, OpenCode 2.0.32, ACP SDK 1.8.0 and Node 24.15.0. The standalone Claude CLI is not necessarily the SDK's binary.

## Remaining work

1. Recover a registered worktree without losing the surviving source. Fix the known lint failure.
2. Review backend and refresh edge cases:
   - `AgentConnection.forkSession` sends rewind metadata without plugin extra roots. Verify plugin delivery survives rewind/fork/resume and add propagation/tests if needed.
   - Reject canonical aliases or overlapping custom skill roots that undermine independent availability; current duplicate checks happen before canonicalization.
   - Add a graceful watcher-error path to `startWatching`.
   - Exercise IO failure halfway through multiple deployments and verify rollback/retry behavior. Preflight covers ordinary conflicts, but multi-target failure needs review.
   - Add coverage for the main-process refresh queue around active turns and asynchronous attach/startup.
   - Check broken-plugin disable/recovery UX and behavior with corrupt deployment state.
3. Extend native integration to edit an already-used skill, refresh/restart/resume, and verify revised content reaches the provider. Current native coverage proves initial loading and disabling; backend coverage proves file propagation.
4. Run the full test suite, typecheck, lint and build. Fix regressions only on the feature worktree.
5. Test the built app with a fresh temporary user-data directory: real IPC creation, editing, supporting files, connection references, enable/disable, custom setup, deletion preserving shared connections, and restart persistence.
6. Visually inspect the built Plugins screen in light/dark and at narrower widths. Keep launch helpers and screenshots in `%TEMP%`.
7. Update `docs/SPEC.md`, including the stale Extensions statement that Gloss does not configure extensions. Document storage, supported delivery, limits, dependency ownership, refresh and unsupported components. Update phase-1 completion notes only when true.
8. Review and commit the implementation on the feature branch if appropriate. Report how to try it and material limits. Do not merge into `dev` or start phases 2/3 without review.

## References already checked

- Installed Claude ACP accepts `_meta.claudeCode.options.plugins` and local `.claude-plugin/plugin.json` packages.
- Installed Codex ACP reads `_meta.additionalRoots`; `refreshSkills` adds `<root>/.agents/skills` through its extra-roots API.
- OpenCode v2 uses a `skills` array, not v1's `skills.paths` shape.
- https://code.claude.com/docs/en/plugins-reference
- https://dev.opencode.ai/v2/docs/skills/
- https://dev.opencode.ai/v2/docs/plugins/

Do not recreate the old research reports or standalone probe script in the repo. The necessary findings are in M19 and this handoff.
