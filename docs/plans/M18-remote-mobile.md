# M18 plan: Remote and mobile

Working notes for [M18](../MILESTONES.md#m18-remote-and-mobile): decisions, verification results and open questions. The design itself goes in `SPEC.md` when it's settled.

## Decisions
- **TLS comes from Tailscale** (2026-10-27). The bridge serves `https://<machine>.<tailnet>.ts.net` with a certificate from `tailscale cert`, instead of a self-signed certificate pinned at pairing. A page can't pin a certificate, and service workers (so the installable PWA and web push) don't register on a page with a certificate error. Tailscale is required for the bridge, at home too; on the same network it connects directly. Gloss builds no certificate generation or local CA.
- **Support iOS and Android.** Verify on an iPhone first (the developer's phone, iPhone 17). iOS only gives web push to a PWA added to the Home Screen, so pairing should tell iPhone users to add it.
- **Phone design** (2026-10-27, from the mock's decisions): a thread starts from a tap on a list item or paragraph and from a text selection (selection alone is too fiddly on a phone). The phone can attach images (same limits as the desktop), start new sessions, and change the model, effort and permission mode. Pushes include a question's text. Pairing codes work once and expire after five minutes. The port defaults to 8443 and is editable in Settings.
- **Device token in a cookie:** keep the token in a `Secure`, `HttpOnly`, `SameSite=Strict` cookie set by the bridge, not in `localStorage`. It carries over to the Home Screen app (verified), page script can't read it, and the WebSocket upgrade sends it automatically.
- **Dependencies** (2026-10-27): `ws` for the WebSocket server and `web-push` for push signing and encryption, rather than hand-written code.

## Verified (spike, 2026-10-27)
Probe: `scripts/probe-bridge.mjs` (run with Electron's Node, `ELECTRON_RUN_AS_NODE=1`).

- **Certificate:** `tailscale status --json` gives the host in `CertDomains[0]` and the address in `Self.TailscaleIPs`. `tailscale cert --cert-file <f> --key-file <f> <host>` (Tailscale on Windows, not admin) writes a Let's Encrypt certificate valid 90 days: about 34 s the first time, 0.2 s from its cache afterwards. MagicDNS and HTTPS Certificates must be on in the tailnet's DNS settings.
- **Server:** `node:https` with that certificate plus `ws@8.22` on the same server, bound to the Tailscale IPv4 only, reached an iPhone (iOS 26) in Safari and as a Home Screen app. No Windows Firewall prompt. WebSocket round trips were 20 to 180 ms.
- **iOS web push:** the Home Screen app registered the service worker; `pushManager.subscribe` (after `Notification.requestPermission()` from a tap) gave a `web.push.apple.com` endpoint, and `web-push@3.6` delivered a notification (201 in about 0.2 s). Apple answers `403 BadJwtToken` when the VAPID subject is a `mailto:` at a reserved domain (`example.invalid`); an `https://<host>` subject works.
- **Safari to Home Screen app (D8):** on iOS 26 the Home Screen app did not see Safari's `localStorage` (null), but did get the cookie Safari had set before Add to Home Screen. It opened at the manifest's `start_url` with its query intact (`/pair?code=TEST123`). So a device token kept in a cookie survives the move, and a pairing code in `start_url` is a fallback. The probe set the cookie from script; a server-set `HttpOnly` cookie is expected to behave the same but wasn't tested.
- The renderer's security settings are untouched: the desktop windows keep loading `file://`, and the bridge is a separate HTTPS server in the main process.

## Certificate renewal (verified 2026-10-28)
- `tailscale cert --min-validity <d>` (Tailscale 1.104.2) returns the cached certificate in about 0.04 s while more than `<d>` is left, and reissues when less is: asking for 2153 h with 2151.5 h left gave a new Let's Encrypt certificate in 34 s (valid Oct 28 to Jan 26). Gloss uses 720 h.
- The running bridge switches certificates with `server.setSecureContext`: a test over TLS with two fixture certificates shows new connections get the new one while a phone connected before keeps working. Restarting the scratch app served the renewed certificate.

## Still to verify
- Android (Chrome) push and install: deferred, no Android device to test with soon (2026-10-27). Built to the standards; untested.
- What the phone sees when Tailscale is off on either side, for "Gloss is offline".

## Code notes
- `GlossApi` (`src/preload/index.ts`) is invoke calls plus one event stream, and `GlossEvent` is serializable, so the bridge can mirror it. The handlers are registered inline on `ipcMain` in `src/main/index.ts`, several checking `e.sender`; they need a shared table taking a caller (window or paired device) so both transports run the same code.
- `emit()` in `src/main/index.ts` fans events out to windows and fires desktop notifications; the bridge adds device fan-out there, and push uses the same "no Gloss window focused" rule.
- The phone gets an allowlist. Desktop-only or unsafe from a phone: `openFileLink`, `sessions.openFolder`, `sessions.openObsidian`, `settings.*`, `capture`/`annotate`, `files.pathFor`. `readMarkdownImage` reads local files and needs a decision.
- The mobile client can be another Vite entry with a WebSocket-backed `window.gloss`, reusing `Markdown`, `Log`, `RequestCard` and `Composer`.

## Open questions
- None.

## Built (2026-10-27)
- Shared handler table (`src/main/phoneApi.ts`), the bridge (`bridge.ts`), Tailscale (`tailscale.ts`), push (`push.ts`), lifecycle (`phone.ts`), the phone client (`src/renderer/mobile/`, `mobile.html`, `public/`) and Settings → Phone (`PhoneSettings.tsx`).
- Checked against the built app on a scratch data folder: the bridge starts from the setting with Tailscale's certificate and the strict CSP header; pairing over CDP + `fetch` set the HttpOnly cookie; allowlisted calls answered and `settings.get` was refused; Remove closed the socket with 4001 and `/me` then answered 401.
- Headless Edge at 390×844 with an iPhone user agent paired through the real page, listed the session, tapped a list item (highlight and Reply bar), opened the new thread and sent a reply. While its Haiku turn ran the phone showed Steer and Stop, and the desktop reported the turn in that thread; the desktop then had the thread's messages.
- The bridge serves `out/renderer` from disk, so the phone needs a renderer build (`npx electron-vite build`); `npm run dev` alone doesn't write it.

## Next
Done on the iPhone (pairing, Home Screen, notifications, the daily loop) and certificate renewal. Android remains untested.
