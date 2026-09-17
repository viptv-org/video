# Contributing to VIPTV video

This repository owns the headless playback controller: the `Player` interface,
the platform adapters, and the server session coordinator. Keep changes inside
that boundary. Visible controls and playback policy belong to the
applications; native Tauri playback engine code belongs in
[`viptv-org/tauri-video-plugin`](https://github.com/viptv-org/tauri-video-plugin).

## Set up

Use Node.js 20+ and install from the committed lockfile:

```sh
npm ci
```

`npm ci` runs `prepare` (`npm run build`), which generates `dist-js`.

## Cross-repository consumption

`viptv-org/tv-web` installs this package via `file:../video` and resolves
types and code from the generated `dist-js`. Build order matters:

```sh
cd video && npm run build    # before consumer checks
cd ../tv-web && npm test     # sees the fresh dist-js
```

`dist-js` is generated output — never hand-edit it or commit debug artifacts.

## Design expectations

- Keep adapter selection explicit; the controller escalates a delivery
  refusal only through the server's managed ladder for the same source.
- Keep browser/TV capability claims aligned with implemented behavior.
- Preserve the one `Player` contract: snapshot/subscribe, session
  invalidation, and typed failures.
- Applications bind their own API client through the structural
  `PlaybackBackend` port; this package never imports application code.

## Validate a change

Start with the smallest relevant test, then run the repository gates:

```sh
npm run check   # typecheck + vitest
npm run build   # rollup → dist-js
```

When you change the public contract, read [`VERSIONING.md`](VERSIONING.md)
and record the release in `CHANGELOG.md`.
