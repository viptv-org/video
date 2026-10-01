# TypeScript video controller specification

Derived from the code at the revision that carries this file. When code and this
document disagree, the code is the bug report: fix one so they match.

## Purpose and ownership

`viptv-org/video` is the shared headless playback controller for the tv-web UI
on web browsers, Vizio SmartCast, Samsung Tizen and the Tauri desktop host. It
supplies one `Player` interface, explicit platform adapters, and the
`PlaybackSessionController` that coordinates a server playback session with one
adapter. It owns no product screen, API client, or source selection.

**UX authority** is the [`viptv-org/design`](https://github.com/viptv-org/design)
repository (pinned in `DESIGN_REF`) and its design canvas: controls, focus,
button/hold behavior, overlays, resume, source selection, up-next and episode
transitions. This package exposes facts and commands for that UI and never
creates a conflicting product behavior.

## Adapter selection

`createPlayer({ platform })` selects exactly one adapter; nothing is inferred
from the user agent.

| Platform | Adapter | Engine |
| --- | --- | --- |
| `html5` | `Html5FallbackAdapter` | MediaBunny → HTML media → MediaBunny-MSE |
| `vizio` | `VizioHtml5Adapter`, or `Html5FallbackAdapter` without a canvas when `localRemux` is on | HTML media |
| `tizen` | `TizenAvplayAdapter` | Samsung AVPlay via an injected `AvplayManager` |
| `tauri` | `TauriNativeAdapter` | `tauri-plugin-video` over raw IPC |

### Direct first, explicit fallbacks

The server's original (direct) delivery is always attempted first; fallbacks
are explicit, bounded, and keep the same selected source.

`Html5FallbackAdapter` builds its local path list per open:

1. **MediaBunny** (WebCodecs to a canvas) when a canvas, a secure context,
   `BigInt`, `VideoDecoder` and `AudioContext` are available.
2. **HTML media** (`VizioHtml5Adapter`): native HLS when `canPlayType` accepts
   it, then **hls.js** (MSE transmux) when native HLS fails or is absent;
   progressive files play natively.
3. **MediaBunny-MSE** local remux, appended only when the host enabled
   `configureBrowserPlayback({ localRemux: true })` and `MediaSource` exists.

Managed fragmented MP4 (`deliveryFormat: 'fmp4'`) has one bounded response body
and uses HTML media only. A path failure advances to the next path only when
`canChangeMediaPath` holds (`unsupported-format`, `engine-unavailable`,
`performance-limited`, and the reason is not `network`, `authorization` or
`autoplay`); each open has a 15 s bound. A late MediaBunny decoder failure
continues the same session on the next path at the current position.

`configureBrowserPlayback({ clientInspection, localRemux })` is the host's
rollout switch: `clientInspection` enables direct-delivery caption discovery,
`localRemux` enables the MSE path and local audio-track inspection, and either
switch makes Vizio send its probed browser profile instead of the declared one.

### Tizen AVPlay

`TizenAvplayAdapter` drives the narrow `AvplayManager` port (open, prepare,
play/pause, seek, track info/selection, optional `setDisplayRect` and
`setStreamingProperty`). Source authorization supports only `Cookie` and
`User-Agent`, applied with `setStreamingProperty('COOKIE' | 'USER_AGENT')` in
the IDLE state. Any other header, or a runtime without `setStreamingProperty`,
fails with `authorization-unsupported` so the controller can request gateway
delivery. The Tizen delivery profile (`TIZEN_DELIVERY_CAPABILITIES`) declares
the native 1920×1080 decoder envelope (H.264, HEVC Main/SDR, AAC).

### Tauri desktop

`TauriNativeAdapter` speaks the raw `plugin:video|native_*` IPC commands of
`tauri-plugin-video` (protocol 1); it does not use the plugin's JavaScript
façade.

- **Handshake.** Before the first open it calls `native_diagnostics` and
  requires `protocolVersion === 1`; otherwise `engine-unavailable`. Each
  `native_open` carries `protocolVersion`, `packageVersion` and a fresh
  `sessionKey`.
- **Engine.** `engine: 'auto'` (default) requests the first engine listed in
  `diagnostics.engines` (the plugin lists GStreamer first). An explicit engine
  (`gstreamer` | `mpv`) is sent as-is; if the diagnostics show it was not
  compiled, open fails with `engine-unavailable` before `native_open`.
- **Validate before teardown.** Source authorization is validated before the
  current native session is torn down, so an invalid request never stops the
  playing session. A superseded open closes only its own key; the plugin
  ignores stale-key cleanup.
- **Surface.** Linux places the native surface under a transparent DOM
  aperture kept in sync through `native_layout`; Windows receives a WebView2
  texture stream on the real `<video>` element after
  `native_prepare_texture_stream`.
- **Open retry.** A `PIPELINE_FAILED` open is retried once with the same
  payload; a first frame must appear within 8 s unless `expectedVideo: false`.
- Cookie, User-Agent and arbitrary headers are forwarded to the engine.

## Server session controller

`PlaybackSessionController` binds a `PlaybackBackend` port
(`startPlayback(request, { signal })`, `stopPlayback(id)`) to one `Player`.

### Managed ladder

One selected source escalates only through the server delivery ladder:
**original → `managedOnly` → `forceTranscode`**.

- **Admission refusals.** Only a 406 from `startPlayback` escalates, at most
  two rungs. Status 0 (transport failure) never converts media; 400, 401, 403,
  429 and every other status surface unchanged.
- **Decoder failures** (at open or later during playback) escalate when
  `canChangeMediaPath` holds for the failure: direct → `managedOnly`, managed →
  `forceTranscode`. A late failure recovers at most once per backend session,
  at the absolute position and paused state (live reopens at the edge).
  `engine-unavailable` never changes delivery: a missing engine is a host
  fact that no other rung can fix.
- **Gateway proxy retry.** A direct delivery that fails with
  `connection-failed` or `authorization-unsupported` gets exactly one
  `managedOnly` attempt through an authorized gateway, without forcing
  conversion. Managed-delivery and control-API failures never take this path.
- **Carry-forward.** Each retry keeps the previous request (including its
  `conversionReason`) and adds the failure's track `selection` and `reason` as
  `conversionReason`, so the server converts only what the device could not
  present.
- A candidate that cannot open is stopped exactly once, and the outgoing
  session is restored (position and paused state) before the error surfaces.

### Delivery kind and gateway mode

`isOriginalDelivery(session)` uses the v2 `deliveryKind` (`'direct'` |
`'gateway'`) when present and falls back to `mode === 'direct'` only for older
sessions. `deliveryKind` is delivery authority; the gateway's processing
`mode`/`videoMode`/`audioMode` only describe what the gateway does
(`deliveryDecision`: `original`, `server-remux`, `audio-conversion`,
`video-conversion`). Direct deliveries seek in place on the device and carry
the session's source `authorization`; managed deliveries never do, seek by
replacing the session, and select tracks with `managedOnly`.

### Cancellation

Every public operation (`start`, `seek`, `seekFrom`, `replaceTracks`,
`prepareNext`, `stop`) takes a new operation generation. Pending admissions
whose operation is no longer wanted have their `AbortSignal` aborted; a
session admitted for a superseded operation is stopped immediately. Rapid
managed seeks are coalesced so a superseded replacement never holds provider
capacity. A cancelled operation resolves to the current owner or rejects with
an `AbortError`. Back during `prepareNext` restores the outgoing session if the
device already switched.

## Media gateway fetch fence

All JavaScript-fetched media (MediaBunny inputs, hls.js loads, subtitle and
track files) goes through `sessionMediaRequest`/`sessionMediaFetch`:

- the delivery URL must be `http(s)` without userinfo or fragment, and HTTPS on
  an HTTPS page (Tauri excepted);
- nested resources must share the delivery's origin and directory prefix, and
  encoded `/`, `\` or `%` in the path is refused;
- only `GET`/`HEAD`; only `Range`, `If-Range` and `Accept` are forwarded;
  credentials are omitted, redirects are errors, no referrer is sent;
- 401/403 → `authorization-failed`, 410 → `expired-source`, 406 →
  `unsupported-format` (`container`), other non-2xx except 416 and network
  errors → `connection-failed`. Inside Tauri requests use
  `@tauri-apps/plugin-http`.

## Source authorization

`checkedSourceAuthorization` validates `PlaybackAuthorization` before any
engine sees it, failing with `authorization-failed`:

- at most 32 headers; names match `[A-Za-z0-9-]{1,128}`; names are unique
  ignoring case;
- values, cookie and user agent are at most 8192 characters with no control
  characters;
- hop-by-hop or transport names are forbidden: `host`, `connection`,
  `content-length`, `transfer-encoding`, `proxy-authorization`, `upgrade`,
  `keep-alive`, `te`, `trailer`;
- a `Cookie` or `User-Agent` header is folded into `cookie`/`userAgent` and
  must not conflict with an explicit value.

Adapters that cannot apply authorization (HTML media, MediaBunny, MSE) fail
with `authorization-unsupported` instead of playing without it.

## Typed errors

`PlayerErrorCode` (13): `authorization-unsupported`, `connection-failed`,
`engine-unavailable`, `invalid-state`, `prepare-failed`, `seek-failed`,
`unsupported-operation`, `unsupported-format`, `autoplay-blocked`,
`authorization-failed`, `expired-source`, `performance-limited`, `unknown`.

`MediaFailureReason`: `container`, `video-codec`, `audio-codec`, `rendering`,
`performance`, `network`, `authorization`, `autoplay`. Failures may carry a
track `selection` (`audioTrackIndex`, `subtitleTrackIndex`) for the retry.

Native wire mapping (`tauri-native/wire.ts`): `PROTOCOL_MISMATCH`,
`RUNTIME_UNAVAILABLE` → `engine-unavailable`; `PIPELINE_FAILED` →
`unsupported-format`; `AUTHORIZATION_FAILED` → `authorization-failed`;
`CONNECTION_FAILED` → `connection-failed`; `SOURCE_UNAVAILABLE` →
`expired-source`; `INVALID_REQUEST` → `prepare-failed`; anything else → the
operation's fallback code.

An operation refused while playback continues (for example an unservable
seek) throws without failing the session.

## Live, DVR and timeline

`PlaybackKind` is `vod` or `live`.

- The server-known title length is authoritative (`timelineDuration`); only an
  original-file engine may raise it, and the published duration only grows.
  Managed output is a rolling window offset by `timelineOffsetSeconds` and
  never defines the title length. Live has no duration.
- `PlayerTime.seekable` reports the engine's seekability; `bufferedEndSeconds`
  and `bufferedRanges` are reported only when real. MediaBunny live publishes
  `liveWindow {start, end, target}` with `seekable: false`.
- Live sessions refuse VOD seeking with `unsupported-operation` (MediaBunny,
  MSE, Tauri); a native engine's unseekable window is enforced, not
  dispatched.

## Capability profiles

The server chooses a rung from the profile the host sends.
`platform-profiles.ts` declares Tizen and Vizio, imports the Tauri
direct-play profile (`directUrls`, 3840×2160), and measures only the web
browser. `PlaybackCapabilities.maxWidth`/`maxHeight` are real decoder limits;
there is no separate profile quality cap.

## Privacy

Adapters and the controller never log source URLs, headers, cookies or
credentials; diagnostics report engine, transport, decision, codecs and
dimensions only.

## Acceptance

`npm run check` (typecheck + unit tests) and `npm run build`. Platform adapter
changes need browser, TV device or Tauri host evidence; capability claims stay
scoped to the tested runtime.
