# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

VIPTV applications and viewers using browser-based playback on desktop, the
Tauri desktop host, Samsung Tizen, and Vizio SmartCast televisions. Television
viewers operate from several feet away with a directional remote rather than a
pointer; the visible UI itself is owned by the applications, not this package.

## Product Purpose

`@viptv/video` is the canonical headless playback controller: one `Player`
interface, the platform adapters, and the server session coordinator shared by
every client that renders the tv-web UI.

## Positioning

One stable controller survives source and delivery changes while platform
adapters retain their native playback path. Applications select the platform
explicitly; direct play and client capability checks come before any server
conversion.

## Capabilities and Constraints

- Playback must work without touch, hover, or a pointer; the UI contract lives
  in the applications and the design repository.
- Live channels must distinguish a non-seekable feed from a moving DVR window;
  a non-seekable channel does not offer seeking.
- Vizio uses the platform HTML/HLS pipeline with managed server delivery; the
  Tauri host plays natively with no server conversion.
- The server-known title length is authoritative; a rolling managed window
  never becomes the seek bar's duration.

## Product Principles

- Playback state is more important than decorative chrome.
- The active focus target is never ambiguous (owned by the application UI).
- Unsupported platform capabilities fail honestly rather than degrade silently.

## Accessibility & Inclusion

Essential player actions are reachable with arrows and Enter in the consuming
UI; the controller exposes the state and track surfaces that require.
