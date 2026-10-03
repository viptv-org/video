# Validation

## Initial native VOD resume intent — 2026-10-02

A real Linux source-picker trace retained queue position30, backend request30,
direct delivery position30 and native-open start30. GStreamer's initial snapshot
had unknown duration0 and inferred live=true; the adapter skipped the resume
seek and decoded from0. Startup now takes VOD/live intent from the selected
request, rather than transient native metadata. Live requests remain free of
VOD startup seeks even if their initial metadata reports otherwise.

Both public adapter/IPC regressions fail before this correction and pass after.
All128 adapter/controller tests, typecheck and package build pass. Actual native
Resume30 replay remains a separate consumer check; this change does not qualify
the outstanding moving-controls/sidebar flicker, GTK rendering or hardware.

## Native seek confirmation and picture-mode command — 2026-10-02

A real Linux desktop source-picker run admitted generated header-protected
H.264/AAC media through an authenticated backend direct lease. GStreamer
advanced its position and issued an authorized byte-range seek, while the
adapter incorrectly reported that the origin replayed the beginning. Native
flush-seek acknowledgments may temporarily report zero before later statistics
show the decoded target.

The focused regression rejected before the change and resolves after bounded
engine-stat confirmation. Actual origin replays remain operation failures; stop
or a superseding seek cancels confirmation. `npm run check` passes typechecking
and 119 tests, including confirmation, cancellation and native picture commands;
`npm run build` passes. These are adapter tests. The desktop consumer must adopt
this revision and invoke `setPictureMode` before native Fit/Fill UI is qualified.
The GStreamer plugin's crop implementation and installed-device checks are
separate. No production service, real provider, installer publication or Windows
qualification was used.

## Native direct source headers — 2026-09-29

Typecheck, 111 tests and build passed. Direct deliveries preserve arbitrary
required source headers through the Tauri IPC boundary, with Cookie/User-Agent
mapped to native properties. Invalid or conflicting values fail before replacing
an active native session, without exposing values. Browser and AVPlay transports
reject unsupported headers explicitly; the controller may request authorized
gateway proxy delivery once, without forcing encoding. Native authorization,
connection and missing-source failures retain distinct player codes. These are
adapter/controller tests; real Linux engine evidence is in the plugin's
VALIDATION.md. Windows/physical TV qualification remains pending.

## Backend admission cancellation — 2026-09-29

Controller generations now abort obsolete pending backend admissions through an
optional request signal. Stop, replacement and next-episode cancellation retain
the existing late-result release/rollback checks for ports that ignore signals.
106 tests, typechecking and build passed, including stop-before-admission-response
and preventing a late stop acknowledgement from overwriting a newer playback.
The application transport owns bounded remote cleanup; the controller does not
log or process media credentials. Consumer integration is recorded in TV-web.
Direct media connection failures may try one authorized gateway delivery without
forcing encoding (for example browser CORS). A control-API outage or a managed
media connection failure never triggers conversion. Unit coverage distinguishes
these paths; provider/device network qualification remains separate.

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
# Concurrent stop cleanup — 2026-10-02

The real `PlaybackSessionController.stop` seam reproduced two failures:
withheld native stop prevented any backend lease release, and rejected native
stop skipped release entirely. Both regressions fail on `0eb875b` and pass when
lease release begins concurrently with native stop. Completion awaits both
settlements and preserves failure propagation and operation-generation fencing.
All 123 tests and type checks pass. Integrated native window/audio/child-process
exit and actual backend DELETE remain desktop-host qualification at its exact
adopted revisions; this unit proof does not certify them.
# Native exit release order — 2026-10-02

Actual GTK fault injection showed that concurrent JavaScript requests cannot
guarantee HTTP dispatch before a native close blocks the shared UI thread.
The explicit `releaseBeforePlayer` stop option settles the backend release
before calling native close. New real-controller regressions verify that order,
preserve a newer player after delayed release, and close after release rejection.
The first two fail on `b1818f9`; all 126 tests, type checks and package build pass.
Actual DELETE-before-blocked-GTK and bounded process/audio teardown remain the
desktop host's integrated qualification; this library owns no process watchdog.
