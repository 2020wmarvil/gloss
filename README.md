# Gloss

**G**raphical **L**ayer **O**ver **S**hell **S**essions

*Goodbye, Long Off-topic Scrolling Sessions.*

A desktop GUI for coding agents (using [Agent Client Protocol](https://agentclientprotocol.com)) that lets you reply to a single point in an agent's answer as its own thread.

## Install

Download the installer from the [latest release](https://github.com/2020wmarvil/gloss/releases/latest):

- **Windows:** `Gloss-Setup-<version>.exe`.
- **macOS and Linux**: the `.dmg` or the `.AppImage`.

Gloss runs the coding agents you already have. Install at least one and sign in to it once:

- **Claude Code** 2.1.233 or newer
- **Codex** 0.160.1 or newer
- **OpenCode** v2

## Development

```sh
npm install
npm run dev
```

### Cutting a release

Bump the version in a pull request, then tag `main` once it's merged:

```sh
npm version 1.2.3 --no-git-tag-version   # on a branch; open a PR and merge it
git checkout main && git pull
git tag v1.2.3 && git push origin v1.2.3
```
