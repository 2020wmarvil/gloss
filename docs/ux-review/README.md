# M12 UX review: inventory and problem list

Phase 1, steps 1 and 2 (`docs/MILESTONES.md` → M12). Captured on 2026-10-20 from the built app (`dev` after PR #28) at 1280×820, on a scratch profile and a scratch git project, with a live Claude Code agent on Haiku 5.5. Most states are in light and dark (`-light.webp`, `-dark.webp` in `screens/`); a few are light only.

The problem list is the input for the target design (tokens, components, mocks). It describes what is wrong, not how to fix it, except where a fix is obvious.

## Inventory

| # | Screen and state | Themes |
|---|---|---|
| 01 | Empty app (no project) | L D |
| 02 | Project open, no session | L D |
| 03 | Project switcher menu | L D |
| 04 | New session with another agent (menu) | L D |
| 05 | Session row hover | L |
| 06 | New session, nothing sent | L D |
| 07 | Composer with a typed prompt | L |
| 08 | Turn running, first tool call | L D |
| 09 | Turn finishing (answer in, Cancel still shown) | L D |
| 10 | Turn done | L D |
| 11 | Plan, tool calls and answer from the top | L D |
| 12 | Tool details expanded | L D |
| 13 | Selection popover (Reply to selection, Copy) | L D |
| 14 | New thread from a selection | L D |
| 15 | Thread answered, anchor marker with reply count | L D |
| 16 | Thread done | L D |
| 17 | Main turn running | L |
| 18 | Thread running while the main composer queues | L D |
| 19 | Main composer turns into Queue | L |
| 20 | Queued main message delivered | L D |
| 21 | Queue drained | L |
| 22 | Long tool call running | L D |
| 23 | Message queued from a thread (queue card, counts) | L D |
| 24 | Typing in the main composer while main runs (steer) | L D |
| 25 | Threads overview while running | L D |
| 26 | Threads overview | L D |
| 27 | Queue tab, empty | L |
| 28 | Usage popup | L D |
| 29 | Model picker | L D |
| 30 | Effort picker | L D |
| 31 | Extensions popup | L D |
| 32 | Session context menu | L D |
| 33 | Sidebar collapsed to its rail | L D |
| 34 | Search, empty | L |
| 35 | Search results | L D |
| 36 | Settings, five scroll positions (1 in both themes) | L D |
| 37 | Review session before the first pass | L D |
| 38 | Review after the first pass (finding cards, gutter dots) | L D |
| 39 | Review line thread open | L D |
| 40 | Review threads overview (general conversation, filters) | L D |
| 41 | Review file list | L |
| 42 | Review unified view | L |
| 43 | Review general conversation | L D |
| 44 | Review range picker | L |
| 45 | Sidebar with a review session row | L |
| 46 | New OpenCode session | L D |
| 48 | 900px-wide window | L D |
| 49 | Sign-in dialog (signed-out Claude) | L D |
| 50 | Failed turn (sign-in cancelled) | L D |
| 51 | List-item replies on | L D |
| 52 | Notice: session deleted outside Gloss | L D |

**Not captured:** OS notifications, the F11 full-screen hint (the shortcut is handled in the main process, out of reach of CDP), a Codex session, the MCP server editor and import preview, the export menu, inline rename, the delete confirmation, image and file attachments, keyboard focus states (Phase 2's accessibility pass), and macOS/Linux.

## Problem list

Priority: **P1** breaks a layout or misleads; **P2** a visual language problem that touches many screens; **P3** local clutter or polish.

### Broken or misleading (P1)

1. **Thread composer collapses while a thread runs.** Cancel, Send to main and Send/Queue squeeze the editor until "Reply in thread" wraps one word per line (18, 19).
2. **Narrow windows starve the conversation.** At 900px (the minimum is 720) the sidebar and thread panel keep their default widths and the conversation gets about 225px: text wraps every few words, the composer placeholder stacks one letter per line, and the status line breaks into six rows (48). The spec's 360px minimum for the conversation only seems to hold for dragged widths.
3. **"+ New session" wraps onto two lines** in the sidebar's split button, with the agent name cut to "Claude C…" (every screen with the sidebar).
4. **The activity strip reports the wrong thing.** While the main turn runs a command it still says "Done in “walk the Map…”" from the earlier thread, and that line stays forever after (23, 26).
5. **A running command says "pending"** (blue dot) while it is executing (22, 23).
6. **The review toolbar wraps** onto a second row when the side panel is open (39 to 44).
7. **A failed turn barely registers.** One line of small centred grey text ("The turn failed: Sign-in was cancelled."), no failed colour or icon, no Sign in or Retry action; the sidebar's dot just disappears (50).
8. **The "deleted outside Gloss" notice is styled as an error.** Red text wedged between Review changes and the session list pushes the list down and can't be dismissed. A row also stays highlighted with no session open (52).

### Visual language (P2)

9. **No button hierarchy.** At least five treatments do the same jobs: the gradient Send/Queue/New session, solid pink "Reply to selection", grey-outlined Cancel and Send to main next to the gradient Send, plain outlined Settings buttons, and pink text links ("← All threads"). Disabled Send is the gradient at low opacity, which reads as pink rather than disabled and turns maroon on dark (06, 10, 13, 15, 36).
10. **The accent has no fixed meaning.** Pink marks focus rings, links, the active composer, selected files, thread counts, the Comments toggle, the review icon, usage meters at normal levels, and "Agent is working…" text. Next to bug red it is hard to tell apart (39, 41), and working is pink text in one place and blue dots elsewhere (18).
11. **Icon controls are a mix of glyphs and icons.** «, », ▸, ▾ and stacked ▲▼ text glyphs sit beside SVG icons; some icon buttons are boxed, some bare; collapsing the sidebar and the side panel uses three different treatments (14, 33, 37).
12. **Monospace is used for things that aren't code**: agent names in headers, the plan's labels, the range picker's commit subjects, line ranges in the overview, input placeholders, the branch in the status line (06, 11, 40, 44, 36).
13. **Native controls break the style**: OS `<select>` dropdowns and checkboxes (35, 36) and the classic Windows scrollbar with arrow buttons in the log, code blocks and the diff (10, 20, 39).
14. **Three input styles in one screen**: white right-aligned fields with monospace placeholders, a full-width grey field, and native controls (36). The range picker's filter has an amber focus ring where everything else is pink (44).
15. **Code surfaces don't agree**: a near-black command block above a pale output block with blue text in tool details (12), pale code blocks in messages, and dark navy hunk headers and olive selected lines in the dark diff (39 dark).
16. **Dark mode has little depth**: warm brown-grey panels with near-black title bar and code blocks, so panels barely separate (10 dark, 39 dark).

### Clutter and noise (P3)

17. **Tool calls dominate turns.** Each is a full-width card with "completed" spelled out; an internal ToolSearch call shows as the first thing the agent did; paths use backslashes; the review's first pass shows two `cd "C:/Users/…"` commands cut mid-path (08, 10, 43).
18. **The status line is a row of unlabeled values**: "4% of 1000k $0.01 5h ok Haiku 5.5 Medium bypass Extensions", with "1000k" for 1M, "5h ok" for plan limits, and "bypass" vs "auto-approving" for the same idea (10, 46). Its buttons don't look like buttons.
19. **Sidebar rows use four different markers**: none (Gloss sessions), a hollow circle (agent-only), a pink ≡ (review) and a pink "4 open" pill (45). The footer (Search conversations, Settings) is two plain rows with rules. The project switcher spends its second line on a truncated monospace path.
20. **Debug-like text in the thread composer**: "sent as: [re: "…"] …" in monospace under every thread composer (14).
21. **"1 queued" shows twice**, as a chip after the activity strip and as amber text at the start of the status line (23).
22. **Search results repeat themselves**: every result repeats the session title and full absolute path, and snippets show raw markdown backticks (35).
23. **Model picker and Extensions popup are noisy**: model descriptions repeat the name ("Opus 5.5 · Opus 5.5 · Best…"), the current model is only pink text with no check, effort reads "Xhigh"; Extensions is a wall of truncated monospace commands (29, 30, 31).
24. **List-item replies turn a list into a table** with monospace numbers and an empty right column until hover; the reply-count chip wraps onto its own line (51).
25. **Review details are heavy**: hunk "show more" controls are boxed stacked chevrons heavier than the hunk header; finding cards are floating shadowed bubbles in a flat diff; the overview's filters take two rows; "src" repeats under every file (37, 38, 40, 41).
26. **The status line floats over the diff** in a review with the side panel closed, with no band or background (37, 38).

### Unclear (P3)

27. **Steer vs queue is invisible.** The main composer's button says "Send" while it will steer the running turn and "Queue" while another thread runs, with nothing explaining either (19, 24).
28. **The session menu is right-click only**; nothing on hover suggests it exists (05, 32).
29. **The side rail's "0"** next to a speech bubble doesn't say what it counts (06).
30. **Empty and first-run states are thin**: "Send a message to start." sits top-left far from the composer (06); a new session opens the side panel just to say "No threads yet" (46); thread rows don't show which message they hang off (26).
31. **Settings is one 3,100px scroll** (Global, MCP servers, OpenCode, Project, Keyboard shortcuts) with no section navigation; the shortcut reference lives at the bottom of it (36).
32. **The sign-in dialog doesn't explain itself**: two options whose descriptions repeat their titles, and no word that a terminal will open (49).

### Worth keeping

- The empty app's bead, wordmark and single gradient button (01, 02).
- Finding cards with a severity tag, coloured edge and gutter dot (38).
- The usage popup's labelled meters and reset times (28).
- The inline anchor highlight and reply-count marker (15), and the plan card (11).
- The review's general conversation summary with its "4 findings, 4 opened as threads" footer (43).
