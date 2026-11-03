# Perforce projects

Install the `p4` command-line client and configure the workspace as you normally would. Gloss uses that configuration, including `P4CONFIG`, the selected client and your existing login ticket. Run `p4 login` yourself when needed. Gloss does not store credentials, log in, change server trust, or run Perforce write commands.

Open the mapped project folder in Gloss. A Perforce-only folder is selected automatically. When both Git and Perforce are detected, choose which to use. Change the selection later in the project's **Version control** setting. Existing reviews keep their original provider. Existing Git projects retain their behavior.

Any supported agent can work in the folder. To have an agent open files for edit or add, supply a Perforce plugin through Gloss's plugin library or the agent's own setup. Gloss bundles none. Worktrees, branch links and pull request actions are unavailable in Perforce projects.

## Reviews

**Review changes** shows a **Changes** picker:

- **Workspace** includes all files opened in the current client and unopened changes inside the selected project folder.
- **Default changelist** includes only files opened in the default changelist.
- Numbered pending changelists include only their opened files. Submitted and shelved revisions are not review ranges.

Files are compared with their have revisions, using the source revision for moves. Adds, deletes and renamed files are represented explicitly. Text line endings are normalized; binary or oversized files have metadata-only rows. The text limit is 1 MB. Opened files elsewhere in the client appear under **Outside this folder**. Unopened changes outside the project folder are not scanned.

Line threads and **Run review** work as in Git reviews. Refreshed workspace reviews discover unopened agent edits inside the project. Changelist reviews discover those edits only after the files are opened in the selected changelist. If a changelist is submitted or deleted, choose another range rather than expecting Gloss to reinterpret the old selection.

The status line shows the stream or client name and `*` when files are opened. **N not opened** checks only paths reported by the agent during its latest turn. Shell edits without reported paths may be absent from that count; use the workspace review to discover them. Login and connection failures are shown with an actionable tooltip.

The `@` picker asks Perforce to apply its effective ignore rules, including `P4IGNORE`. Tracked files remain available even when an ignore rule matches them. It does not traverse symlinks and uses bounded traversal for large folders.

## Development verification

With `p4` and `p4d` installed, run:

```text
npm run test:perforce
node scripts/test-perforce.mjs --unicode
npm test
npm run lint
npm run build
```

`P4_BIN` and `P4D_BIN` can locate the fixture client's and server's executables. The application itself discovers `p4` on PATH. The harness generates classic and stream workspaces, text and binary files, non-ASCII filenames, a Git repository inside the classic workspace, and pending changes. It tests opened/unopened membership, moves, deletes, ignore rules, project subfolder scope, path containment and stream detection. It also logs out its fixture user, expires a short-lived fixture ticket, and stops its server to test actionable errors. Fixture data and tickets live in a temporary directory, the server binds to loopback, and teardown stops the server and removes the directory. No fixture files are committed.

SessionManager's fake-agent tests verify Perforce context, findings/line threads, persisted selection, refresh routing after a provider preference change, and rejection of Git worktree actions. Git regression tests remain part of the ordinary suite.

Verified on Windows with client/server 2026.1. Unicode-server paths use UTF-8 argument files where the CLI supports them. Non-Unicode metadata uses tagged output decoded with the Windows ANSI code page because JSON output replaces non-UTF-8 filename bytes. The local `ignores` command requires direct arguments. Filenames containing line breaks or Perforce's recursive wildcard are rejected. SSL trust setup, SSO, edge/proxy servers and case-sensitive servers on other operating systems need separate environment testing.
