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
optional `authorization` (cookie/User-Agent) that adapters apply only when
their engine supports it. Failures are typed `PlayerErrorCode` values; every
operation outside a live session throws `invalid-state`.

## Session controller

```ts
const controller = new PlaybackSessionController({ player, backend, capabilities })
```

`backend` is a structural port — `startPlayback(request: PlaybackStart):
Promise<PlaybackSessionView>` and `stopPlayback(id: string): Promise<void>` —
satisfied by the application's API client. Delivery refusals are `Error`s
carrying an HTTP-like `status` (0 means transport failure). The controller
escalates status 0/406 and decoder failures through the managed ladder,
restores the outgoing session when a candidate cannot open, and coalesces
rapid managed seeks.

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
