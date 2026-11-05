# Marketing assets

The source of the README's visuals, the demo reel and the social preview, so they can be redone after UI changes.

- `media/`: what gets published: `hero-dark.png`, `hero-light.png`, `threads.gif`, `steer.gif`, `pins.gif`, `gloss-demo.mp4`, `social-preview.png`.
- `footage/`: the recorded clips and stills the reel is built from.
- `capture.mjs`: records `footage/` and the screenshots and GIFs in `media/`.
- `reel/`: the reel, an HTML timeline. Scene order, lengths, captions and zooms are at the top of `reel/reel.js`. `reel/music.m4a` is its backing track (see Music); any other track can replace that file.
- `social/`: the social preview page.
- `render.mjs`: renders the reel and the social preview.

Requires `ffmpeg` on PATH, and `claude` installed and signed in. All of this runs with Electron and ffmpeg, with no extra dependencies.

## Redoing it

```sh
npm run build
node marketing/capture.mjs                  # all scenes, or name some: threads steer pins review stills phone
node marketing/render.mjs                   # the reel and the social preview
node marketing/render.mjs social            # just the preview
node marketing/render.mjs stills 5 20 41    # frames at those times, in docs/plans/m27/, for a quick look
```

A full capture takes a few minutes and a small amount of Haiku usage. Gloss's window is on screen meanwhile; leave it alone. Don't run it inside a shell that has a capture running.

`review` needs the edits `steer` makes, and `stills` needs the sessions `threads` makes, so they can't be run alone. `phone` can, and needs Tailscale with HTTPS certificates on.

## How capture stays clean

- It drives the built app, unmodified, over CDP, in a new scratch data folder (removed afterward), with `ANTHROPIC_MODEL=haiku` and without inherited `CLAUDE*`/`ANTHROPIC*` variables.
- The project is a throwaway written at `C:\gloss-demo\trailmap` (`/tmp/gloss-demo/trailmap` elsewhere), so no user name shows in a path. Before and after each run it deletes that folder and Claude Code's transcripts for it, and nothing else.
- The phone scene turns on this run's own bridge, on port 8497 so a real Gloss's isn't disturbed, and pairs it with a phone-sized window. It listens on the tailnet only and ends with the run; the pairing is in the scratch data.
- The pin scene pastes a screenshot of the demo page and annotates that, so the overlay never captures the real desktop.
- Two things are added to the page while recording: a drawn cursor, since screen captures don't include the real one, and a style hiding the status line's plan usage, which is the account's own.

## Music

"From Page to Practice" by Bryan Teoh, released under CC0 through FreePD, cut to 100 seconds and brought down to a background level. The file's own tags say it was "composed and dedicated to the Public Domain in 2020". FreePD has since closed; the copy came from [a mirror of its library](https://a.ocv.me/pub/stuff/music/freepd/README.md).

## After changing the reel

Upload the new `media/gloss-demo.mp4` by dragging it into any GitHub comment box, and put the URL it gives into the root `README.md`'s `<video>` tag. GitHub plays only those uploads inline. The social preview is uploaded by hand as well: Settings > General > Social preview.
