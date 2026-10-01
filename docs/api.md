# API

## Entry

`@viptv/video` exports the whole controller surface from its root.

## Creating a player

```ts
import { createPlayer } from '@viptv/video'

const player = createPlayer({ platform: 'html5', video, canvas })
```

- `platform: 'html5'` — MediaBunny (WebCodecs) preferred with an HTML5
  fallback; requires a `video` element (and a `canvas` for the MediaBunny
  render path).
- `platform: 'vizio'` — HTMLMediaElement with native HLS then hls.js/MSE;
  requires a `video` element.
- `platform: 'tizen'` — AVPlay native through an injected `avplay` manager
  (`AvplayManager`), so the adapter is testable without a TV.
- `platform: 'tauri'` — the native engine of `tauri-video-plugin` over raw
  IPC; requires a `video` element and fails honestly outside the Tauri host.

## Player

```ts
interface Player {
  readonly capabilities: PlayerCapabilities
  readonly snapshot: PlayerSnapshot
  open(request: OpenPlayerRequest): Promise<void>
  play(): Promise<void>
  pause(): Promise<void>
  seek(positionSeconds: number): Promise<void>
  stop(): Promise<void>
  dispose(): Promise<void>
  selectAudioTrack(trackId: string): Promise<void>
  selectTextTrack(trackId: string | null): Promise<void>
  setVolume?(level: number): Promise<void>
  setMuted?(muted: boolean): Promise<void>
  subscribe(listener: PlayerListener): () => void
}
```

`open` accepts an already-selected delivery URL with the server's timeline
facts: `deliveryMode` ('direct' | 'managed'), `timelineOffsetSeconds`,
`timelineDurationSeconds`, `adoptEngineDuration`, `startAtSeconds`, and an
optional source `authorization` (`cookie`, `userAgent`, and arbitrary request
`headers`, validated by `checkedSourceAuthorization`: at most 32 headers,
token names, no control characters, no hop-by-hop names, no conflicting
duplicates). Adapters apply only what their engine supports — Tauri forwards
all three, Tizen AVPlay only cookie/User-Agent — and otherwise fail with
`authorization-unsupported`. Failures are typed `PlayerErrorCode` values;
every operation outside a live session throws `invalid-state`.

## Session controller

```ts
const controller = new PlaybackSessionController({ player, backend, capabilities })
```

`backend` is a structural port — `startPlayback(request: PlaybackStart,
options?: { signal?: AbortSignal }): Promise<PlaybackSessionView>` and
`stopPlayback(id: string): Promise<void>` — satisfied by the application's API
client. The controller aborts the `signal` when a newer operation supersedes a
pending admission. Delivery refusals are `Error`s carrying an HTTP-like
`status` (0 means transport failure). Only a delivery refusal (406) escalates
through the ladder (original → `managedOnly` → `forceTranscode`, at most two
rungs); status 0 and every other status surface unchanged. Decoder failures
the device cannot present escalate the same way, a direct transport or
header failure gets one authorized gateway attempt without conversion, the
outgoing session is restored when a candidate cannot open, and rapid managed
seeks are coalesced.

## Capability profiles

Adapters declare their engine capability records
(`VIZIO_HTML5_CAPABILITIES`, `TIZEN_AVPLAY_CAPABILITIES`), while
`platform-profiles.ts` is the canonical declaration point for the delivery
profiles a platform sends with its playback requests:
`TIZEN_DELIVERY_CAPABILITIES`, `VIZIO_DELIVERY_CAPABILITIES`, the
direct-play-only `TAURI_NATIVE_DELIVERY_CAPABILITIES`, and the measured
`webDeliveryCapabilities` browser report with its managed-HLS gate.
`deliveryCapabilitiesFor(platform)` resolves the profile for an entry point;
TV engines and the Tauri host never consult a browser decoder probe.
