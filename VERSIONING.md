# Versioning and compatibility

`@viptv/video` is versioned independently from the native Tauri engine plugin.
A release of this repository is required only when it changes; it does not
receive a matching version bump merely because the plugin releases.

## Before 1.0

Pre-1.0 releases use `0.COMPATIBILITY.PATCH`:

- increment `PATCH` for every backward-compatible change, including fixes,
  performance improvements, and additive APIs or capabilities;
- increment `COMPATIBILITY` when existing consumers must change code or can
  observe an incompatible contract change.

of an existing adapter capability or option. A new optional export, event
field, or capability is normally backward-compatible.

For example, `^0.4.1` accepts compatible `0.4.x` releases but not `0.5.0`.
Within the VIPTV organization the consuming application pins this package via
a cross-repository `file:` dependency, so compatibility epochs are observed by
the application's own checks rather than a registry range.

## After 1.0

Starting at `1.0.0`, releases follow standard Semantic Versioning:

- `MAJOR` for backward-incompatible changes;
- `MINOR` for backward-compatible features;
- `PATCH` for backward-compatible fixes.

## Tauri plugin compatibility

The Tauri native adapter speaks the raw IPC protocol of
`viptv-org/tauri-video-plugin` and verifies the protocol version at open time.
The plugin's Rust crate and this package are versioned independently; the
protocol handshake (`PROTOCOL_MISMATCH`) is the compatibility gate at runtime.

## Release rules

- Record every release under an exact `## X.Y.Z` heading in `CHANGELOG.md`.
- Published versions are immutable and must never be reused.
- The organization does not publish to a registry yet; releases are git tags
  in `viptv-org/video` until the delivery policy is approved.
- A release is created only after its exact version-bump commit passes
  `npm run check` and `npm run build` locally.
