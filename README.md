# Gloss

**G**raphical **L**ayer **O**ver **S**hell **S**essions

*Goodbye, Long Off-topic Scrolling Sessions.*

A desktop GUI for coding agents (using [Agent Client Protocol](https://agentclientprotocol.com)) that lets you reply to a single point in an agent's answer as its own thread.

[Using Perforce projects and reviews](docs/PERFORCE.md)

## Install

Download the installer from the [latest release](https://github.com/2020wmarvil/gloss/releases/latest):

- **Windows:** `Gloss-Setup-<version>.exe`. It installs for your user only, without an admin prompt.
- **macOS and Linux** (best effort): the `.dmg` or the `.AppImage`.

Gloss runs the coding agents you already have. Install at least one and sign in to it once:

- **Claude Code** 2.1.233 or newer ([install](https://code.claude.com)). Update it with `claude update`.
- **Codex** 0.160.1 or newer: the CLI (`npm install -g @openai/codex`) or the Codex app.
- **OpenCode** v2 (set up in Settings > Agents).

Gloss finds Claude Code and Codex on your PATH or where their installers put them. If it can't, set `claudeExecutable` or `codexExecutable` to the native executable in the settings file (Settings, then **Open in editor**).

Gloss updates itself on Windows and Linux: it downloads new releases in the background and shows **Restart to update** in the sidebar when one is ready. Turn this off in Settings > General. On macOS, download new versions from the releases page.

### Unsigned builds

Gloss releases aren't code signed, since a certificate costs money every year. You'll see a warning the first time:

- **Windows:** SmartScreen says "Windows protected your PC". Choose **More info**, then **Run anyway**.
- **macOS:** the app is blocked on first open. Open **System Settings > Privacy & Security** and choose **Open Anyway**.

Updates are checked against the SHA-512 hashes published with each release, so a download corrupted on the way is rejected. Without a signature, though, an update is only as trustworthy as this repository's releases.

## Development

```sh
npm install
npm run dev
```

`npm run build` typechecks and builds to `out/`; `npm run dist` also packages an installer for the current platform into `dist/`. `npm test` runs the tests and `npm run lint` the linter.

### Cutting a release

From an up-to-date `main`:

```sh
npm version 1.2.3   # bumps package.json, commits and tags v1.2.3
git push origin main v1.2.3
```

The tag starts the Release workflow, which builds the installers (Windows must succeed; macOS and Linux are best effort) and publishes the GitHub Release with notes from the merged pull requests. Installed copies pick it up through auto-update.
