# VIPTV video

The canonical headless playback controller for VIPTV: the `Player` interface,
the platform adapters (MediaBunny/WebCodecs behind an HTML5 fallback, Vizio
HTML/HLS, Samsung Tizen AVPlay, and the Tauri native engine), and the
`PlaybackSessionController` that coordinates one device adapter with the
server's opaque playback sessions and delivery ladder.

The stack moved here from tv-web per design ADR 0003 (shared platform matrix
and playback consolidation). The inherited get-air `guest-js`/React controller
surface was deleted, not merged: this package deliberately accepts an
already-selected delivery URL and never discovers or ranks sources — visible
controls, the API client, and playback policy belong to the applications
(`viptv-org/tv-web`).

This repository was independently imported from `get-air/video` at
`a6a5650abe3e906d201ef92d02f55b8d32d323cb`; source history and the Apache-2.0
and MIT license texts remain intact.

## Surface

- `createPlayer({ platform, video, canvas, avplay })` — one factory for the
  platform adapters; `platform: 'html5' | 'vizio' | 'tizen' | 'tauri'`.
- `Player` — synchronous `snapshot()` plus `subscribe(listener)` push, a
  ten-state machine, session-ID invalidation, and typed `PlayerErrorCode`
  failures. Adapters fail honestly where an engine lacks a capability.
- `PlaybackSessionController` — coordinates the server's opaque session
  through a `PlaybackBackend` port (`startPlayback`/`stopPlayback`), escalates
  delivery refusals (status 0 or 406) through the managed ladder, and restores
  the outgoing session when a candidate cannot open.
- Server contract types — `PlaybackCapabilities`, `PlaybackStart`,
  `PlaybackSessionView`, `PlaybackMediaTrack` — so applications bind their own
  API client without the controller importing application code.
- `probeBrowserPlaybackCapabilities` — measured browser capability report
  (canPlayType, MediaCapabilities.decodingInfo, MSE, WebCodecs probe).

## Development

```sh
npm ci          # install from the committed lockfile; prepare builds dist-js
npm run check   # typecheck + vitest
npm run build   # rollup → dist-js
```

Consumers (`viptv-org/tv-web`) install this package via `file:../video`. Build
order matters: run `npm run build` here before running consumer checks,
because consumers resolve types and code from `dist-js`. See
`CONTRIBUTING.md` for the workflow.
