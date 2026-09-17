# VIPTV video agent guide

Read `DESIGN_REF` and `SPEC.md` first. This repository owns the headless
playback controller: the `Player` interface, the platform adapters (MediaBunny
with an HTML fallback, Vizio HTML/HLS, Tizen AVPlay, and the Tauri native
engine), and the `PlaybackSessionController`. Applications own visible
controls, the API client, and playback policy; adapters accept an
already-selected delivery URL.

All backend selection is explicit. Direct playback and client capability
checks come before any server conversion; the controller escalates a delivery
refusal only through the server's managed ladder. Preserve typed failures,
source replacement safety, independent track selection, and distinct
on-demand/DVR/non-seekable-live behavior. Never log source URLs, headers,
cookies, licenses, or local paths.

Keep web/TV behavior aligned with the design repository. Test the changed
adapter plus controller checks locally. Do not add CI/CD or publication
automation until the organization delivery policy is approved.

Consumers install this package through a cross-repository `file:` dependency
(`@viptv/video` in viptv-org/tv-web). Build order matters: run `npm run build`
in this repository before running the consumer's checks — consumers resolve
types and code from the generated `dist-js`, which is never hand-edited.
