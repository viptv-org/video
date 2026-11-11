import type { OpenPlayerRequest, PlayerTrack } from './types';
import { mediaLanguage } from './primitives';

/** Presentation of the selected output; input indices belong to the server. */
export function subtitleIntent(request: OpenPlayerRequest, tracks: readonly PlayerTrack[]): string | null | undefined {
  if (request.textTrackId === null) return null;
  if (request.textTrackId !== undefined)
    return tracks.find(track => track.id === request.textTrackId && track.available)?.id;
  if (!request.preferredSubtitleLanguage) return undefined;
  const language = mediaLanguage(request.preferredSubtitleLanguage.toLowerCase());
  return tracks.find(track => track.available && track.language && mediaLanguage(track.language.toLowerCase()) === language)?.id
    ?? (request.deliveryMode === 'managed' && tracks.length === 1 && tracks[0].available &&
      (!tracks[0].language || tracks[0].language === 'und' || language === 'und') ? tracks[0].id : undefined);
}
