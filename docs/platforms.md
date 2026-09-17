# Platform behavior

## Explicit selection

Applications select one platform through `createPlayer`. The controller never
infers an engine: the host declares what it is (browser, Vizio receiver,
Tizen, Tauri window), and the server's delivery matrix follows the capability
profile the application sends.

## Web browser

MediaBunny (WebCodecs) is preferred behind a secure-context plus
`VideoDecoder`/`AudioDecoder` gate with a bounded open timeout; the HTML5
fallback uses native HLS, then hls.js/MSE. `probeBrowserPlaybackCapabilities`
measures what this exact runtime can decode (canPlayType,
`MediaCapabilities.decodingInfo`, MSE, WebCodecs).

## Vizio SmartCast

The `vizio` adapter uses the HTMLMediaElement pipeline with native HLS, then
hls.js/MSE. SmartCast's old Chromium has no WebCodecs, so there is no
MediaBunny path: Vizio stays on managed server delivery, and the adapter's
capabilities declare no request headers and no audio-track selection.

## Samsung Tizen

The `tizen` adapter drives AVPlay through an injected, narrow `AvplayManager`
(`play`, `open`, `seek`, track selection, optional `setStreamingProperty` for
cookies/User-Agent, optional `setDisplayRect`). The application loads
Samsung's WebAPI library (`$WEBAPIS/webapis/webapis.js`) in its TV page and
passes the manager at construction; remote media origins must be allowed by
the application's `config.xml` content security policy.

## Tauri desktop

The `tauri` adapter speaks the raw IPC protocol of `tauri-plugin-video`
(`native_open`/`native_control`/`native_layout`/`native_stats`/`native_close`)
through `@tauri-apps/api/core`, with a protocol-version handshake at open. On
Linux the native surface renders under a DOM aperture the adapter keeps in
sync; on Windows frames arrive as a WebView2 texture stream on the video
element. The host's media and API requests route through
`@tauri-apps/plugin-http` (`sessionMediaFetch` does this under
`__TAURI_INTERNALS__`); playback is native with no server conversion.
