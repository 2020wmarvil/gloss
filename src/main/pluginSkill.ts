/** The built-in skill that lets any agent create or import a plugin (SPEC → Plugins → Import). */
export const BUILTIN_SKILL = 'gloss-plugins'

type Context = {
  /** The plugin library folder. */
  library: string
  /** Gloss's settings.json. */
  settings: string
  agents: { id: string; name: string }[]
}

/** SKILL.md for the built-in skill, with this machine's paths and agents filled in. */
export function builtinSkill({ library, settings, agents }: Context): string {
  const ids = agents.map(a => `\`${a.id}\` (${a.name})`).join(', ')
  return `---
name: ${BUILTIN_SKILL}
description: "Create a plugin in Gloss, or import an existing plugin or skill into Gloss's plugin library. Use when the user asks to add, import, install or set up a plugin, skill or MCP server in Gloss."
---

# Gloss plugins

Gloss keeps a library of plugins that it delivers to the agents the user picks. A plugin is one or more skills (with their supporting files) and references to MCP servers in Gloss's settings. You create or import one by writing files; Gloss notices the change, validates it and shows any problem on its Plugins screen.

- Library: \`${library}\`
- Settings: \`${settings}\`
- Agents: ${ids}

## Plugin layout

\`\`\`
<library>/<plugin-id>/
  plugin.json
  skills/<plugin-id>-<skill-name>/SKILL.md
  skills/<plugin-id>-<skill-name>/<supporting files>
\`\`\`

- \`<plugin-id>\`: lowercase letters, digits and dashes, starting with a letter or digit. The skill folder name is the plugin id, a dash and the skill name, at most 64 characters in all.
- \`plugin.json\` has exactly these fields, no others:
  \`\`\`json
  { "schemaVersion": 1, "name": "Display name", "description": "One line.", "connections": [], "enabledAgents": [] }
  \`\`\`
  \`connections\` lists the names of MCP servers in settings this plugin needs. \`enabledAgents\` lists the agent ids that get the plugin; leave it empty unless the user said which agents should have it.
- \`SKILL.md\` starts with frontmatter whose \`name\` equals its folder name and whose \`description\` is a single line. Other frontmatter fields may stay.
- Only ordinary files and folders: no links. At most 1,000 files and 64 MB per plugin, 12 folder levels.
- Other files a skill or server uses (scripts, server code) may sit anywhere in the plugin folder. Gloss refuses a plugin with \`hooks\`, \`agents\`, \`commands\`, \`.mcp.json\`, \`mcp.json\`, \`index.js\`, \`index.ts\` or \`.claude-plugin\` there.
- \`${BUILTIN_SKILL}\` is reserved for this skill. A plugin name already in the library can't be reused (names are compared ignoring case).

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
3. **Only skills and MCP servers.** Commands, agents (subagents), hooks, LSP servers, output styles and Codex \`.app.json\` connectors are not imported: Gloss gives every agent the same plugin, and those only work in one agent. Don't turn them into skills. Tell the user which were left out and what they would have done.
4. **Rename the skills** to \`<plugin-id>-<skill-name>\`: rename the folder and set \`name\` in its frontmatter to match. Update references between the plugin's own skills to the new names.
5. **Paths.** Replace \`\${CLAUDE_PLUGIN_ROOT}\` with the new plugin's absolute folder in the library, and \`\${CLAUDE_SKILL_DIR}\` with the skill's absolute folder, in skill files and in server commands and arguments. Other agents don't expand them.
6. **Servers.** Read the plugin's servers from \`.mcp.json\` (either \`{ "mcpServers": { ... } }\` or the servers at its top level) or from \`mcpServers\` in its manifest, and convert each to the format above. If settings already has an identical server, use it. If the name is taken by a different server, add this one under a new name. Put the names in \`connections\`. A \`\${VAR}\` in a value can't stay: Gloss passes values as written. Use the value from your environment if it's set, otherwise ask the user, and say that settings.json stores it as plain text. Drop agent-specific fields (Codex's \`enabled\`, \`env_vars\`, \`cwd\`, timeouts, tool approval settings), turning \`env_vars\` into \`env\` values from your environment.
7. **Don't run anything** from the source (install scripts, hooks, servers) while importing. If a server needs setup first (installing its dependencies, signing in), say so and ask before doing it.
8. **Write in this order:** servers into settings first, then the plugin folder, with \`plugin.json\` last, so Gloss doesn't see a half-written plugin.

## Afterwards

Tell the user what you created: the plugin, its skills (with their new names), the servers you added or reused, and what you left out. Gloss applies the change to agents that have the plugin once their turns finish; skills reach new sessions, or a session after it's reopened. The user turns a plugin on for more agents in Gloss under Plugins → Agents, where any problem with it is shown.
`
}
