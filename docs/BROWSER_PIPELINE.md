# Mediabunny-first browser delivery

The optional browser pipeline follows design PB-001. Hosts enable
`configureBrowserPlayback({ clientInspection: true, localRemux: true })` before
creating players. Both switches default off. Server inspection additionally
requires `VIPTV_BROWSER_PREPARATION=1`; old clients retain their contract.

## Ownership and recovery

WebCodecs uses the selected track's decoder configuration and lazy AC-3/E-AC-3,
DTS and ProRes extensions. The display loop follows the audio output clock,
freezes on underflow, and drops obsolete frames. Codec availability is evidence,
not a promise: initialization/decoding may still refuse a track.

Native/hls.js and local MSE copy complement WebCodecs. The MSE adapter uses
fragmented MP4, forced copying, append backpressure, a 32 MiB source cache and
20 s ahead/10 s behind. Quota pressure shrinks those windows. Continuous raw
transport streams use encoded packet sources directly, avoiding the conversion
API's full-duration scan. No browser encoding is used. Seeks restart at a keyframe
and consume preroll. Every source replacement cancels obsolete work.

Only media incompatibility or sustained decoding performance advances the
conversion ladder. Authentication, expired URLs, connection failures and autoplay
restrictions do not authorize video encoding. Player-local IDs remain distinct
from canonical server stream indexes. Actual tracks, quality, buffered ranges,
caption cues and safe diagnostics are available in snapshots. Thumbnail work is
bounded and initiated by the seek control.

## Qualification, 2026-09-27

- Chromium, Firefox and Playwright WebKit: real HTTPS MKV copy, WebCodecs and
  automatic selection; long-GOP paused seeks, Spanish audio switch and disposal.
  Nine cases per engine. WebKit here is the Playwright Linux build, not physical
  Safari/iOS qualification.
- Chromium: continuous paced HTTPS MPEG-TS through WebCodecs and MSE, pause,
  resume and Stop; live HLS window refresh while paused; upstream quality and
  Auto switching; actual backend original, remux, video conversion and VTT paths.
- Physical Vizio V655-G9 / firmware 2.600.596.0-10 / Conjure
  MTKB-7.600.259.0-prod: WebCodecs unavailable in page and worker. A 30-minute
  local MSE-copy run completed with advancing native time and bounded buffer.
  Short 1080p30/60 AVC and 2160p24 Main/Main10 SDR HEVC samples played with zero
  reported native drops, including seek/resume.
- This Vizio's frame callback reports only time zero and canvas capture cannot
  see its hardware video plane. Do not infer frame-accurate seek or optical AV
  synchronization from those APIs. The soak did not continuously record the
  native dropped-frame counter. HDR and sustained 4K are not qualified.

The exact firmware evidence table is in `vizio-evidence.ts`; newer firmware does
not inherit it. Runtime MSE checks must also pass. Healthy-network release gates
remain AV skew <=80 ms, dropped frames <1%, bounded memory/storage and responsive
controls. Short compatibility cases do not establish every sustained gate.

## Reproduce

`python3 tests/browser/make-fixtures.py <fixture-directory> --hd --soak` builds synthetic media.
Run `tests/browser/server.mjs` with `MEDIA_TLS_CERT`, `MEDIA_TLS_KEY` and a trusted
HTTPS hostname, then `MEDIA_TEST_URL=<https harness URL>
MEDIA_TEST_BROWSERS=chromium,firefox,webkit node tests/browser/check.mjs`.
`tests/browser/harness.ts` also exposes quality, caption and real-engine checks.
The backend example `browser_check` accepts a fixed synthetic fixture whitelist,
runs on loopback and uses no accounts or production database. Keep diagnostics,
source credentials, device tokens and private results outside Git.

### Startup comparison

Five alternating runs per case in Chromium, using trusted local HTTPS and
fresh pages with the same synthetic media. Times below measure adapter open to
its first decoded canvas frame; module loading, provider latency and server
preparation are excluded. Baseline is video `6c6545e`; candidate is `af63620`.

| Source | Baseline p50 / p95 | Candidate p50 / p95 |
|---|---:|---:|
| H.264/AAC MKV | 45.6 / 68.8 ms | 43.5 / 47.6 ms |
| H.264/AAC MP4 | 33.1 / 36.6 ms | 26.9 / 33.5 ms |
| H.264/AC-3 MKV | 47.8 / 62.7 ms | 57.3 / 68.1 ms |

The AAC cases improved; the AC-3 extension case increased about 5 ms at p95.
These small samples measure local preparation, not end-to-end household startup
percentiles. Binary promotion uses the separate server benchmark.
