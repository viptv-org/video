# Changelog

Release numbering follows the
[versioning and compatibility policy](VERSIONING.md).

## Unreleased

- Selectable native engines: `createPlayer({ platform: 'tauri', engine })`
  requests 'mpv' or 'gstreamer' through the plugin's backend field, with
  'auto' following the plugin's reported engine preference order, and the
  running engine surfaces as `PlayerDiagnostics.backend` alongside
  `NativeVideoDiagnostics.engines` and `NativeVideoSnapshot.backend`.
- Retry a PIPELINE_FAILED native open once with the exact same delivery: a
  flaky provider that truncates its first response (playbin3 typefind "Stream
  doesn't contain enough data") gets a fresh engine session before the
  failure reaches the session controller's delivery escalation.

- Add canonical per-platform delivery profiles in `platform-profiles.ts`:
  `TIZEN_DELIVERY_CAPABILITIES` and `VIZIO_DELIVERY_CAPABILITIES`, the
  measured `webDeliveryCapabilities` wrapper with its managed-HLS gate, and
  the `deliveryCapabilitiesFor(platform)` dispatch for platform entry
  points.
- Direct-URL delivery for native hosts: `PlaybackCapabilities.directUrls`
  (declared by the Tauri profile) marks a client that plays the ORIGINAL
  absolute source URL and never accepts managed delivery — the session
  controller does not escalate such clients up the delivery ladder, so
  refusals and decoder failures surface honestly instead of falling to
  transcode. A playback session's source `authorization` now flows into
  `OpenPlayerRequest.authorization` for native playback.

## 0.4.0

- Remove the retired canvas/Blits custom-renderer entrypoint and
  `transparent-canvas` attachment mode. The supported presentation surface is
  an ordinary DOM video element.
- Rename the package `@get-air/video` → `@viptv/video` and point repository
  metadata at `viptv-org/video`.
- Move tv-web's player stack in as the canonical controller: the `Player`
  types, `SessionPlayer`/`PlaybackSessionController`, browser capability
  probing, and the MediaBunny/HTML5-fallback/Vizio/Tizen/Tauri-native
  adapters, with the tv-web suite (8 files, 77 tests) moved alongside.
- Delete the inherited get-air controller surface: `guest-js/` backends and
  client, the React integration, controls, Effect bindings, and their docs.
- Replace `Pick<TvApi, …>` with a structural `PlaybackBackend` port and typed
  playback contract types (`PlaybackStart`, `PlaybackSessionView`,
  `PlaybackMediaTrack`, `PlaybackCapabilities`); delivery-refusal escalation
  keys on the port's documented error status instead of `TvApiError`.
- `SessionStartIntent` is generic over the application's catalog item and
  source types so apps keep their own richer types.
- `exactResumeSource` stays with the application (tv-web's continuation
  module): the rule is owned by the shared Rust core.
- MediaBunny and its codec extensions, hls.js, and the Tauri API/HTTP plugins
  are direct dependencies; vitest 3.2.4 with vite 6.1.0 keeps the test
  transform aligned with the consuming application.

## 0.3.0

- Add the now-retired renderer-specific video integration.
- Add a structural video-element controller for shared headless media controls.
- Add backend-neutral Canvas, WebGL, and WebGPU hole-punch shader registration.

## 0.2.0

- Remove automatic backend selection and the MediaBunny/WebCodecs backend.
- Default omitted backend selection to explicit HTML and preserve only
  caller-supplied fallback chains.
- Require HTML playback to reach `canplay` and produce video dimensions.

## 0.1.1

- Added an explicit, augmentable adapter-error contract so platform packages
  can preserve their schema-backed typed errors through both Promise and Effect
  clients without coupling core to a platform runtime.
- Preserved registered adapter errors from controller operations while keeping
  unmarked or merely tag-shaped failures normalized as `VideoLoadError`.
- Added an enforced release-consistency gate and documented the independent
  core/platform versioning policy.

## 0.1.0

- Add the DOM-first player/controller API and explicit backend registry.
- Add HTML, Tizen AVPlay, webOS, and Vizio backends.
- Add React, canvas, and Blits integrations.
- Add shared SRT/WebVTT subtitle handling and Request-based transport injection.
- Add controller playback-rate support for HTML and Vizio media elements.
- Add guarded Tizen AVPlay ownership and dedicated cookie/User-Agent streaming properties.
