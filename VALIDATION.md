# Validation

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
