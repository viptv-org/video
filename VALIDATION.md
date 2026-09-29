# Validation

## Backend admission cancellation — 2026-09-29

Controller generations now abort obsolete pending backend admissions through an
optional request signal. Stop, replacement and next-episode cancellation retain
the existing late-result release/rollback checks for ports that ignore signals.
104 tests, typechecking and build passed, including stop-before-admission-response.
The application transport owns bounded remote cleanup; the controller does not
log or process media credentials. Consumer integration is recorded in TV-web.

## BE-002 gateway delivery preparation — 2026-09-29

`npm run check` passed typechecking and all 103 tests; `npm run build` passed.

The headless controller distinguishes v2 delivery kind from gateway processing
mode, so a gateway's `mode: direct` cannot turn its rolling output into a native
original-file timeline. Native direct capability no longer prohibits an
authorized gateway fallback; authorization/capacity/network failures still do
not trigger conversion. HTTP source URLs remain usable by native consumers.

Fetch-based media requests accept an explicitly selected external HTTPS gateway
and base path, constrain dependent resources to its origin/session directory,
reject redirects, and omit cookies, Authorization and Referer. HLS uses the real
FetchLoader with the same fence. Native browser HLS sets anonymous cross-origin
mode; its nested requests remain browser-owned, so this is not a claim that
JavaScript intercepts native-HLS redirects. Backend/gateway URL validation and
rewriting remain mandatory. Physical TV/native transport acceptance is pending.

The targeted trusted-HTTPS Chromium harness `tests/browser/gateway-check.mjs`
decoded generated 640x360 HLS through a separate loopback HTTPS origin/base path,
including a child playlist and segments. Seven observed requests carried no
cookies, Authorization or Referer; a redirect was rejected without reaching its
destination, and Range survived. No real provider or production service was
contacted. Start the existing browser server with local TLS certificate envs,
then run the harness with MEDIA_FIXTURES pointing to generated variant.m3u8 and
segmentN.ts files. This does not prove full client v2 lifecycle adoption.

Historical checkpoints follow.

Validated from commit `6735a0b` plus the stage-4 consolidation on 2026-09-17.

| Command | Result |
| --- | --- |
| `npm install --no-audit --no-fund` | passed; lockfile regenerated, `prepare` builds `dist-js` |
| `npx tsc -p tsconfig.json --noEmit` | passed |
| `NODE_OPTIONS=--max-old-space-size=256 npx vitest run --pool=threads --poolOptions.threads.singleThread` | passed: 8 files, 77 tests (the suite moved from tv-web) |
| `npx tsx scripts/build.ts` | passed; `dist-js` regenerated |

This validates the controller and adapter contracts in jsdom. It does not
establish browser, Tizen AVPlay, Vizio/webOS, codec, DRM, HDR, or physical-TV
playback support; those need their target runtime or device. The Tauri native
adapter's IPC surface was verified live on Linux in stage 3 (see tv-web
`TESTING.md`).
