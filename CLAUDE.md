# Gloss

**G**raphical **L**ayer **O**ver **S**hell **S**essions. Use "Gloss" / `gloss` as the product, package and window name.

Electron desktop app: a GUI for coding agents (via the Agent Client Protocol) with threaded replies to individual points in an agent's response.

## Read first
- `docs/SPEC.md` — the design. It is settled; follow it. If something in it seems wrong or unworkable, stop and ask rather than redesigning.
- `docs/MILESTONES.md` — build order.
- `docs/mocks/*.html` — open in a browser for the intended layout and interactions.

## How to work
- Do one milestone at a time. At the end of each, stop: summarize what works, how to run it, and anything that deviated from the spec. Wait for review.
- Respect the **Out of scope** list in the spec. Don't add features from it, even if they seem easy.
- Verify external APIs before relying on them: the ACP TypeScript SDK (`@agentclientprotocol/sdk`) client API, the Claude Code ACP adapter's package name and entrypoint, and whether this Electron version's Node has `node:sqlite`. Check docs or source; don't guess.
- Keep agent/ACP/DB logic in the main process. The renderer talks to it only through the preload IPC API.
- Never relax the Electron security settings in the spec to make something work.

## Stack
- Electron + electron-vite, TypeScript (strict).
- SQLite (`node:sqlite` if available, else `better-sqlite3` + `electron-rebuild`).
- Developer is on Windows; keep scripts cross-platform (no bash-only npm scripts).

## Commands
_To be filled in during M1 (dev, build, lint, test)._

## Dev model
Run the agent with `ANTHROPIC_MODEL=haiku` during development via the app's dev toggle.
