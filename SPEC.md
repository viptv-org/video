# TypeScript video controller specification

## Purpose

`viptv-org/video` is the shared headless TypeScript playback controller for the
tv-web UI on web browsers, Vizio SmartCast, Samsung Tizen, and the Tauri
desktop host. It supplies one `Player` interface and explicit platform
adapters plus the server-session coordinator; it does not own a product
screen, the API client, or source selection.

## Adapter selection

Applications select one platform explicitly (`createPlayer({ platform })`).
Direct native/engine playback is attempted first; the controller escalates a
delivery refusal only through the server's managed ladder for the same
selected source. This preserves quality and avoids unnecessary server cost.

## Media semantics

The controller exposes source opening, play/pause, seek, volume, tracks,
subtitles, capability facts, typed errors, and source replacement. On-demand,
DVR live, and non-seekable live remain distinct. A non-seekable channel does
not offer seeking. A failed adapter advances only to a fallback selected by
the application.

## UX boundary

VIPTV apps use the design repository as source of truth for controls, focus,
button/hold behavior, overlays, resume, source selection, up-next, and episode
transition. This package supports that UI but never creates a conflicting
product behavior.

## Acceptance

Typecheck, unit-test, and build locally (`npm run check`, `npm run build`).
Platform adapter changes need the appropriate browser, TV SDK/device, or Tauri
host evidence. Capability claims remain scoped to the tested runtime.
