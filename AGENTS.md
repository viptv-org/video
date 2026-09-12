# VIPTV video agent guide

Read `DESIGN_REF` and `SPEC.md` first. This project owns one platform-neutral TypeScript playback interface. Applications and the pinned design commit own visible controls and playback policy.

All backend selection is explicit. Direct playback and client capability checks come before any transcoding adapter. Preserve typed failures, source replacement safety, independent track selection, and distinct on-demand/DVR/non-seekable-live behavior. Never log source URLs, headers, cookies, licenses, or local paths.

Keep web/TV behavior aligned with the design repository. Test the changed adapter plus controller and React checks locally. Do not add CI/CD or publication automation until the organization delivery policy is approved.
