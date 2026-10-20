# Gloss brand

Decided in M12 Phase 1 (explorations: `docs/mocks/brand.html`).

## Mark
A glossy bead in the Sunset gradient, used on its own with no tile: the bead is the app icon, round on the taskbar and dock.
- **Master:** `build/icon.svg` (64-unit viewBox): the gradient fill, a radial shade (lit top left, darker underside), a white highlight arc at the top left and a faint reflected light at the bottom right.
- **Small sizes (16 to 32 px):** `build/icon-small.svg`, with a bolder highlight, a lighter shade and no reflected light, so it stays a bead rather than a smudge.
- **Icon files:** `npm run icons` renders both through Electron to `build/icon.ico` (16 to 256), `build/icon.icns` (16 to 1024, with @2x), `build/icon.png` (1024) and `build/icons/<n>x<n>.png` (Linux). Re-run it after editing either SVG.

## Color
- **Sunset gradient:** `#FF3DA6` (magenta) into `#FF9F3D` (orange). Used on the bead and on primary buttons (New session, Send) with dark text `#17040E`.
- **Solid accent** for everything else (links, badges, focus rings, selection): `#FF5C9E` on dark, `#C2147A` on light, where the vivid one is too light for text on the paper background.
- **Tints** for badges and highlighted rows: `#3A1A2C` on dark, `#FAE5F0` on light.
- **Not the brand:** the working state, suggestion findings and diff hunk headers stay blue (`--blue`), and the other state colors are unchanged, so pink never means "running" or "failed".

## Wordmark
`gloss`, lowercase, in Inter Display semibold (SIL Open Font License, bundled with the app so it looks the same everywhere), tracking -0.02em. Set to the right of the bead, the bead's diameter a little larger than the wordmark's font size (22 px beside 19 px in the sidebar). The product is still written "Gloss" in running text and the window title.
