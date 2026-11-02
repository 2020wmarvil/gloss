import { dirname, join } from 'node:path'
/** Earlier names of the new-plugin skill's folders, removed where Gloss wrote them. */
export const LEGACY_BUILTIN_SKILLS = ['plugins', 'gloss-plugins']

type Context = {
  /** The plugin library folder. */
  library: string
  /** Gloss's settings.json. */
  settings: string
  /** What Gloss generates for agents, with `delivery.json`; `state.json` is beside it. */
  runtime: string
  agents: { id: string; name: string }[]
  /** The agents a new plugin is on for. */
  defaultAgents: string[]
}

/**
 * Gloss's built-in skills (SPEC → Plugins → Import, Doctor): `claude` is the name in Claude, inside
 * the plugin `gloss` (`gloss:new-plugin`), like a library plugin's skills; `flat` the name elsewhere.
 */
export type BuiltinSkill = { claude: string; flat: string; render(context: Context, name: string): string }
export const BUILTIN_SKILLS: BuiltinSkill[] = [
  { claude: 'new-plugin', flat: 'gloss-new-plugin', render: (context, name) => newPluginSkill(context, name) },
  { claude: 'doctor', flat: 'gloss-doctor', render: (context, name) => doctorSkill(context, name) }
]

/** SKILL.md for the new-plugin skill, with this machine's paths and agents filled in. */
function newPluginSkill({ library, settings, agents, defaultAgents }: Context, name: string): string {
  const ids = agents.map(a => `\`${a.id}\` (${a.name})`).join(', ')
  return `---
name: ${name}
description: "Create a plugin in Gloss, or import an existing plugin or skill into Gloss's plugin library. Use when the user asks to add, import, install or set up a plugin, skill or MCP server in Gloss."
---

# Gloss plugins

Gloss keeps a library of plugins that it delivers to the agents the user picks. A plugin holds skills (with their supporting files), subagents, hooks and references to MCP servers in Gloss's settings. Each agent gets the parts it supports and silently skips the rest; the \`gloss:doctor\` skill (\`gloss-doctor\` outside Claude Code) explains what each agent got. You create or import one by writing files; Gloss notices the change, validates it and shows any problem on its Plugins screen.

- Library: \`${library}\`
- Settings: \`${settings}\`
- Agents: ${ids}

## Plugin layout

\`\`\`
<library>/<plugin-id>/
  plugin.json
  skills/<skill-name>/SKILL.md
  skills/<skill-name>/<supporting files>
  agents/<subagent-name>.md
  hooks/hooks.json
\`\`\`

- \`<plugin-id>\` and \`<skill-name>\`: lowercase letters, digits and dashes, starting with a letter or digit. The plugin id, a dash and the skill name fit in 64 characters.
- Agents see a skill as \`<plugin-id>:<skill-name>\` in Claude Code and \`<plugin-id>-<skill-name>\` elsewhere, so skill names only need to be unique within their plugin. Don't repeat the plugin id in a skill name.
- \`plugin.json\` has exactly these fields, no others:
  \`\`\`json
  { "schemaVersion": 1, "name": "Display name", "description": "One line.", "connections": [], "enabledAgents": [] }
  \`\`\`
  \`connections\` lists the names of MCP servers in settings this plugin needs. \`enabledAgents\` lists the agent ids that get the plugin. A new plugin is on by default: unless the user named other agents, set it to \`${JSON.stringify(defaultAgents)}\`.
- \`SKILL.md\` starts with frontmatter whose \`name\` equals its folder name and whose \`description\` is a single line. Other frontmatter fields may stay.
- Only ordinary files and folders: no links. At most 1,000 files and 64 MB per plugin, 12 folder levels.
- Other files a skill, hook or server uses (scripts, server code) may sit anywhere in the plugin folder. Gloss refuses a plugin with \`commands\`, \`.mcp.json\`, \`mcp.json\`, \`index.js\`, \`index.ts\` or \`.claude-plugin\` there.
- The plugin id \`gloss\` is reserved for this skill's plugin. A plugin name already in the library can't be reused (names are compared ignoring case).

## Subagents

\`agents/<subagent-name>.md\`, one file per subagent, named like a skill. Claude Code, Codex and OpenCode get them; custom agents don't.

\`\`\`markdown
---
name: reviewer
description: Reviews changes for correctness. Use after editing code.
tools: read-only
model:
  claude: haiku
---

Review the current changes and list findings in severity order.
\`\`\`

- Only these frontmatter fields: \`name\` (the file name without \`.md\`), \`description\` (one line; agents use it to decide when to call the subagent), \`tools\` and \`model\`. The body is the subagent's instructions.
- \`tools\`: \`read-only\` (it can't edit files or run shell commands) or \`inherit\` (the default: whatever the calling session may do). Don't list tool names: they differ between agents.
- \`model\` (optional): a model per agent id (\`claude\`, \`codex\`, \`opencode\`), in that agent's own naming. Leave it out to use the session's model.
- Agents see a subagent as \`<plugin-id>:<name>\` in Claude Code and \`<plugin-id>-<name>\` elsewhere.

## Hooks

\`hooks/hooks.json\` lists commands that agents run automatically on events:

\`\`\`json
{ "hooks": [
  { "event": "beforeTool", "matcher": "shell", "command": "node \\"<absolute path>/check.js\\"", "timeout": 30 },
  { "event": "PreCompact", "command": "...", "agents": ["claude"] }
] }
\`\`\`

- \`event\`: one of Gloss's events, which every agent has: \`sessionStart\`, \`userPrompt\`, \`beforeTool\`, \`afterTool\`, \`stop\`. Or an agent's own event name (for example Claude Code's \`PreCompact\`), which needs \`agents\`.
- \`matcher\` (only for \`beforeTool\` and \`afterTool\`; leave it out to match every tool): \`shell\`, \`edit\`, \`read\`, \`any\` or \`mcp:<server name>\`. An agent's own tool-name pattern (\`Write|Edit\`) needs \`agents\`. Codex has no \`read\` tool, so it skips a \`read\` hook.
- \`agents\` (optional): the agent ids that get this hook (\`claude\`, \`codex\`, \`opencode\`). Without it, every one of them does.
- \`timeout\`: seconds, 60 by default. No other fields.
- The command gets the agent's own JSON on stdin: Claude Code's and Codex's hook input (very similar). OpenCode has no command hooks, so Gloss runs them from a plugin of its own and sends Claude Code's shape with OpenCode's tool names.
- To block, print JSON on stdout: \`{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "..."}}\` for a tool call, \`{"decision": "block", "reason": "..."}\` for a prompt. Every agent understands these. Exit code 2 (with the reason on stderr) also blocks, except in Codex on Windows, whose PowerShell turns it into 1.
- Start a command with a program name and use absolute paths: \`node "C:/plugins/kit/check.js"\`. Codex runs hook commands in PowerShell on Windows, where a command starting with a quoted path is an error, and Gloss doesn't expand variables in commands.

## MCP servers

Servers live only in settings, in the top-level \`mcpServers\` list, shared by every agent. A plugin refers to them by name in \`connections\`.

\`\`\`json
{ "name": "docs", "command": "node", "args": ["server.js"], "env": [{ "name": "KEY", "value": "..." }] }
{ "type": "http", "name": "docs", "url": "https://example.com/mcp", "headers": [{ "name": "Authorization", "value": "Bearer ..." }] }
\`\`\`

\`type\` is \`http\` or \`sse\` for a remote server and is left out for a local one. There is no working-directory field: pass a path in \`args\` instead. Edit settings.json in place: keep every other key and keep it valid JSON. If it isn't valid, Gloss keeps its last good settings and shows the error.

## Importing

When the user points you at a plugin, a skill, a folder of skills or a repository (clone a git URL to a temporary folder first):

1. **Copy, never change the source.** Copy what you import into a new plugin in the library. Don't edit, move, link or delete anything at the source.
2. **Find the skills.** A Claude Code plugin (\`.claude-plugin/plugin.json\`) or a Codex plugin (\`.codex-plugin/plugin.json\`) keeps them in \`skills/\` unless its manifest names other paths. A marketplace (\`.claude-plugin/marketplace.json\`) lists plugins with a \`source\`: a relative path inside the repository, or another repository (clone it). An entry with \`"strict": false\` may list its skills in the marketplace itself. A standalone skill is a folder with \`SKILL.md\`; it becomes a plugin of its own.
3. **Skills, subagents, hooks and MCP servers.** Commands, LSP servers, output styles and Codex \`.app.json\` connectors are not imported. Don't turn them into skills. Tell the user which were left out and what they would have done.
   - **Subagents** (Claude Code's \`agents/*.md\`, Codex's \`agents/*.toml\` roles): convert each to the subagent format above. Keep its name, description and instructions. A tool list with only reading tools (\`Read\`, \`Grep\`, \`Glob\`, web fetching and searching) or a read-only sandbox becomes \`tools: read-only\`; leave out any other tool list. A model goes under that agent's id. Drop other fields (\`color\`, \`permissionMode\`, ...) and say so.
   - **Hooks** (Claude Code's or Codex's \`hooks/hooks.json\`, or \`hooks\` in their manifest): add one Gloss hook per command. Map \`SessionStart\`, \`UserPromptSubmit\`, \`PreToolUse\`, \`PostToolUse\` and \`Stop\` to Gloss's events, and the matchers \`Bash\` to \`shell\`, \`Edit|Write\` (with \`MultiEdit\`, \`NotebookEdit\`) to \`edit\`, \`Read\` to \`read\`, \`mcp__<server>__.*\` to \`mcp:<server>\`, and none or \`*\` to no matcher. Keep any other event or matcher as it is, with \`agents\` set to the agent the plugin was written for. Tell the user the scripts were written for that agent, and that other agents send similar but not identical input.
   - **A plugin with hooks starts off:** set \`enabledAgents\` to \`[]\`, and tell the user to read its hooks in Gloss under Plugins → Hooks, then turn it on for the agents they want. Hooks run commands without asking.
4. **Keep skill names.** Each skill keeps its folder name, and \`name\` in its frontmatter matches it. Rename only a name that isn't lowercase letters, digits and dashes, or that starts with the plugin id and a dash (drop that part). References between the plugin's own skills use these short names.
5. **Paths.** Claude Code plugins refer to their own folders with two variables, each written as a dollar sign followed by the name in braces: \`CLAUDE_PLUGIN_ROOT\` (the plugin's folder) and \`CLAUDE_SKILL_DIR\` (the skill's folder). Replace them with the new plugin's absolute folder in the library and the skill's absolute folder, in skill files, hook commands, and server commands and arguments. Other agents don't expand them.
6. **Servers.** Read the plugin's servers from \`.mcp.json\` (either \`{ "mcpServers": { ... } }\` or the servers at its top level) or from \`mcpServers\` in its manifest, and convert each to the format above. If settings already has an identical server, use it. If the name is taken by a different server, add this one under a new name. Put the names in \`connections\`. A \`\${VAR}\` in a value can't stay: Gloss passes values as written. Use the value from your environment if it's set, otherwise ask the user, and say that settings.json stores it as plain text. Drop agent-specific fields (Codex's \`enabled\`, \`env_vars\`, \`cwd\`, timeouts, tool approval settings), turning \`env_vars\` into \`env\` values from your environment.
7. **Don't run anything** from the source (install scripts, hooks, servers) while importing. If a server needs setup first (installing its dependencies, signing in), say so and ask before doing it.
8. **Write in this order:** servers into settings first, then the plugin folder, with \`plugin.json\` last, so Gloss doesn't see a half-written plugin.

## Afterwards

Tell the user what you created: the plugin, its skills and subagents (and how agents name them, for example git-writing:commit in Claude Code and git-writing-commit elsewhere), its hooks, the servers you added or reused, and what you left out. Gloss applies the change to agents that have the plugin once their turns finish; skills reach new sessions, or a session after it's reopened. The user can turn a plugin off for an agent in Gloss under Plugins → Agents, where any problem with it is shown.
`
}

/** SKILL.md for the doctor skill: works out why a plugin doesn't behave as expected in an agent. */
function doctorSkill({ library, settings, runtime, agents }: Context, name: string): string {
  const ids = agents.map(a => `\`${a.id}\` (${a.name})`).join(', ')
  return `---
name: ${name}
description: "Work out why a Gloss plugin doesn't behave as expected: a skill, subagent, hook or MCP server an agent doesn't get or doesn't run. Use when the user is confused by a plugin they added or imported in Gloss."
---

# Gloss plugin doctor

Gloss delivers each plugin in its library to the agents it's turned on for. Each agent gets the parts it supports and silently skips the rest, so nothing on screen says what was left out. Find out what happened and explain it plainly. Fix it only if the user agrees.

- Library: \`${library}\` (the plugins' own files: change these, never the generated ones)
- Delivery report: \`${join(runtime, 'delivery.json')}\`
- Generated files: \`${runtime}\` (rewritten by Gloss; edits there are lost)
- Deployment state: \`${join(dirname(runtime), 'state.json')}\` (don't edit it)
- Settings (MCP servers): \`${settings}\`
- Agents: ${ids}

For the plugin formats (\`plugin.json\`, skills, subagents, hooks, MCP servers), read the \`gloss:new-plugin\` skill (\`gloss-new-plugin\` outside Claude Code).

## Steps

1. **Which plugin, which agent, what was expected.** Ask if it isn't clear. The current session's agent is one of the ids above.
2. **Read the delivery report.** Under \`agents.<agent id>.plugins.<plugin id>\`: \`on\` (turned on for this agent), \`delivered\` (with a \`reason\` when not: a problem with the plugin's files, a missing MCP server, a failed deployment), the names the agent sees for each skill and subagent, and for each hook whether it was delivered, as which native event and matcher (\`as\`), or why not. Gloss rewrites it whenever the library or settings change.
3. **Check the files** against the formats when the plugin has a problem: \`plugin.json\` fields, frontmatter names matching folders and files, single-line descriptions, \`hooks/hooks.json\` in Gloss's format (a Claude Code plugin's own \`hooks.json\` isn't), no \`commands\`, \`.mcp.json\` or \`.claude-plugin\`. Gloss's Plugins screen shows the same problem.
4. **Look at what the agent got** when it was delivered but doesn't behave:
   - Claude Code: \`${join(runtime, 'claude', '<plugin id>')}\` (\`skills\`, \`agents\`, \`hooks/hooks.json\`), loaded as a local plugin named after the plugin id.
   - Codex: skills in \`${join(runtime, 'codex', '.agents', 'skills')}\`, subagent roles in \`${join(runtime, 'codex', 'agents')}\`. Hooks and subagents reach Codex through Gloss's \`CODEX_CONFIG\`, not its config files. Codex only runs trusted hooks: Gloss records the hash Codex reports for each of its hooks (\`codexHookTrust\` in the deployment state) and starts Codex once more to pass them back as trusted, so a new or edited hook runs from the start after that.
   - OpenCode: skills in \`${join(runtime, 'opencode', 'skills')}\`, subagents in Gloss's \`OPENCODE_CONFIG_CONTENT\`, hooks run by Gloss's OpenCode plugin in \`${join(runtime, 'opencode', 'hooks')}\` (its \`hooks.json\` lists them). OpenCode 1 gets skills only.
   - Custom agents get skills only, in the skill directory set for them.
5. **Common causes.**
   - The change hasn't applied yet: Gloss applies it once the agent's turns finish. Skills, subagents and hooks reach new sessions, or a session after it's reopened. A conversation keeps instructions already in its history.
   - A hook names an agent's own event or tool pattern, or lists \`agents\`, so other agents skip it. Codex has no \`read\` tool.
   - A hook's script expects one agent's input. Claude Code and Codex send similar JSON. OpenCode gets Claude Code's shape with its own tool names (\`shell\`, \`edit\`, \`write\`, \`read\`, \`<server>_<tool>\`).
   - A hook command uses a relative path or a variable such as the Claude plugin root: Gloss passes commands as written, so they need absolute paths.
   - On Windows, Codex runs hook commands in Windows PowerShell: a command starting with a quoted path (\`"C:/x/node.exe" check.js\`) fails there, so start with a program name (\`node "C:/x/check.js"\`); and exit code 2 arrives as 1, so a hook that blocks by exit code doesn't block in Codex. Blocking with JSON on stdout works everywhere.
   - A subagent's model isn't one that agent knows.
   - The plugin is off for that agent (Plugins → Agents in Gloss), or a referenced MCP server is missing from settings.
6. **Testing a hook command runs it.** Ask before you do, then pipe a small sample input to it and show what it prints and its exit code.

## Afterwards

Explain what the agent got, what it skipped and why, and what would change it. Make fixes in the library, never in the generated files.
`
}
