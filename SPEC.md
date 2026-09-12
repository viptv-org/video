# TypeScript video controller specification

## Purpose

`viptv-org/video` is the shared TypeScript playback module for React web, web-based TV, Tizen, Vizio/webOS, and the Tauri native adapter. It supplies one controller interface and explicit adapters; it does not own a product screen.

## Backend order

Applications pass one backend ID or an ordered list. Direct native/HTML playback is attempted first. Tizen uses AVPlay. Tauri uses `viptv-org/tauri-video-plugin`. A server transcode adapter is considered only after direct playback and client capability checks fail. This preserves quality and avoids unnecessary server cost.

## Media semantics

The controller exposes source opening, play/pause, seek, volume, tracks, subtitles, capability facts, typed errors, and source replacement. On-demand, DVR live, and non-seekable live remain distinct. A non-seekable channel does not offer seeking. A failed adapter advances only to a fallback selected by the application.

## UX boundary

VIPTV apps use the design repository as source of truth for controls, focus, button/hold behavior, overlays, resume, source selection, up-next, and episode transition. React helpers support that UI but never create a conflicting product behavior.

## Acceptance

Typecheck, unit-test, and build locally. Platform adapter changes need the appropriate browser, TV SDK/device, or Tauri host evidence. Capability claims remain scoped to the tested runtime.
