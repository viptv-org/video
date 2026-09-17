# VIPTV video design

## Role

One headless playback seam for every VIPTV client that renders the shared tv-web
UI: browsers, Vizio SmartCast, Samsung Tizen, and the Tauri desktop host. The
package owns the `Player` interface, the adapters, and the session coordinator —
never visible controls, the API client, or source selection. Applications pass
an already-selected delivery URL; choosing a source and choosing a server
delivery rung belong to the product and backend.

## Player contract

- Synchronous `snapshot()` plus `subscribe(listener)` push; every listener sees
  the current snapshot immediately.
- A ten-state machine: idle, opening, ready, playing, paused, buffering, ended,
  stopped, error, disposed.
- Session-ID invalidation: `SessionPlayer.isCurrent` makes every stale engine
  callback inert, so a superseded open cannot corrupt the new session.
- Typed `PlayerErrorCode` failures with `PlayerOperationError`; adapters fail
  honestly (`unsupported-operation`) where their engine lacks a capability
  instead of degrading silently.

## Time and duration

The server-known title length is authoritative; only an original-file engine
may raise it (`timelineDuration`/`growOnlyDuration`). Managed output is a
rolling window: its engine duration never becomes the seek bar's length, and
buffered-end is published only when the engine reports a real lead. Live
playback has no VOD seeking.

## Adapters

- **html5** — MediaBunny (WebCodecs) preferred behind a secure-context plus
  `VideoDecoder`/`AudioDecoder` gate with a bounded open timeout; then HTML
  `<video>` with native HLS and an hls.js/MSE fallback. Session-scoped
  `sessionMediaFetch` checks resource prefixes and routes through the Tauri
  HTTP plugin under `__TAURI_INTERNALS__`.
- **vizio** — HTMLMediaElement with native HLS, then hls.js/MSE. No WebCodecs
  path: SmartCast's old Chromium cannot run MediaBunny, so Vizio stays on
  managed server delivery.
- **tizen** — AVPlay native through an injectable, narrow `AvplayManager`
  (testable without a TV; cookies/User-Agent capability-gated on optional
  `setStreamingProperty`).
- **tauri** — the native engine of `tauri-video-plugin` over its raw IPC
  protocol (protocol-version handshake, layout forwarding, stats polling), with
  a direct-play-only capability profile and no server conversion.

## Session coordination

`PlaybackSessionController` coordinates the server's opaque playback session
with one device adapter through a structural `PlaybackBackend` port. It never
discovers or ranks a replacement source. Delivery refusals (HTTP-like status 0
or 406) and decoder failures escalate the same selected source through the
server's ladder — original delivery, managed output, forced conversion — while
preserving position and pause intent, restoring the outgoing session when a
candidate cannot open.
