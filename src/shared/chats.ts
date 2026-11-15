// Chats (SPEC → Chats): conversations that work in the user's second brain, an Obsidian vault.

/** The Chats project's name in the project switcher. */
export const CHATS_NAME = 'Chats'

/** The folder of Gloss's own that stands for Chats: `chats` next to settings.json, in Gloss's data folder. */
export function chatsFolder(settingsPath: string): string {
  const cut = Math.max(settingsPath.lastIndexOf('/'), settingsPath.lastIndexOf('\\'))
  return `${settingsPath.slice(0, cut + 1)}chats`
}

/** Why New chat can't start. */
export const NO_SECOND_BRAIN = 'Set a second brain folder in Settings to start a chat.'

/** Added to the agent instructions of every chat (SPEC → Agent instructions). */
export const CHAT_INSTRUCTIONS = `This is a general chat, not work on a project. The working folder is the user's second brain: an Obsidian vault of Markdown notes, linked with [[wikilinks]].

- Before answering, search the vault (file names and contents) whenever the user's past notes, projects, people, preferences or decisions could matter, and read the notes that do. Mention the notes you used as [[Note name]] links. Don't search for questions that clearly don't need it.
- When the user asks you to remember something, or says something clearly worth keeping (a decision, a preference, a fact about their life or work), add it to the vault: update the note it belongs in, or create one where similar notes live, following the vault's existing structure, naming, frontmatter and link style. Say which note you changed.
- Never reorganise, rename, move or delete notes, and never rewrite what the user wrote, unless asked. Don't touch the .obsidian folder.
- The vault is personal: don't copy its contents anywhere outside it.`
