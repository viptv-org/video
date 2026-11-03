import { expect, it } from 'vitest';
import { adapterRequest, recoveryRequest } from '../src/session-request';
import type { PlaybackSessionView, PlaybackStart } from '../src/types';

const gateway: PlaybackSessionView = {
  id: 'lease', deliveryKind: 'gateway', mode: 'direct', url: 'https://gateway.example/base/media/viewer/cap/index.m3u8',
  headers: {}, format: 'hls', videoMode: 'copy', audioMode: 'copy', position: 120,
  live: false, duration: 3600, audioTracks: [], subtitleTracks: [], subtitlesSupported: false,
  authorization: { cookie: 'must-not-leave-client', userAgent: 'upstream-only' },
};
const start: PlaybackStart = { streamId: 'source', position: 120, managedOnly: true,
  capabilities: { maxWidth: 3840, maxHeight: 2160, h264: true, hevc: true, aac: true, directPlay: true, directUrls: true, hevcSdr: true } };

it('uses an explicit HLS cut offset while the returned decoder position is zero', () => {
  expect(adapterRequest({ ...gateway, position: 0, timelineOffsetSeconds: 48.6 }, 'vod', 48.6, true))
    .toMatchObject({ startAtSeconds: 0, timelineOffsetSeconds: 48.6, paused: true, deliveryMode: 'managed' });
});

it('seeks a full gateway MP4 once without adding an original-media clock offset', () => {
  expect(adapterRequest({ ...gateway, format: 'mp4', position: 48.6, timelineOffsetSeconds: 0 }, 'vod', 48.6, false))
    .toMatchObject({ startAtSeconds: 48.6, timelineOffsetSeconds: 0, adoptEngineDuration: true,
      deliveryMode: 'managed', authorization: undefined });
});

it('keeps live playback at its live timeline rather than a VOD resume position', () => {
  expect(adapterRequest({ ...gateway, live: true }, 'live', 48.6, false))
    .toMatchObject({ startAtSeconds: 0, timelineOffsetSeconds: 0, timelineDurationSeconds: undefined });
});

it('does not confuse gateway processing mode direct with original delivery', () => {
  expect(adapterRequest(gateway, 'vod', 135, true)).toMatchObject({
    startAtSeconds: 15, timelineOffsetSeconds: 120, timelineDurationSeconds: 3600,
    adoptEngineDuration: false, deliveryMode: 'managed', authorization: undefined,
  });
  expect(recoveryRequest(gateway, start, 'unsupported-format')).toMatchObject({ forceTranscode: true });
});

it('native HTTP direct remains an original delivery with its source credentials', () => {
  const direct = { ...gateway, deliveryKind: 'direct' as const, url: 'http://provider.example/movie.mp4', format: 'original' };
  expect(adapterRequest(direct, 'vod', 135, false)).toMatchObject({
    url: direct.url, startAtSeconds: 135, timelineOffsetSeconds: 0,
    adoptEngineDuration: true, deliveryMode: 'direct', authorization: direct.authorization,
  });
});

it('tries proxy delivery for a direct media connection failure but never forces encoding for it', () => {
  const direct = { ...gateway, deliveryKind: 'direct' as const };
  const first = recoveryRequest(direct, { ...start, managedOnly: false }, 'connection-failed');
  expect(first).toMatchObject({ managedOnly: true });
  expect(first?.forceTranscode).toBeUndefined();
  expect(recoveryRequest(gateway, first!, 'connection-failed')).toBeUndefined();
  expect(recoveryRequest(direct, first!, 'connection-failed')).toBeUndefined();
});
