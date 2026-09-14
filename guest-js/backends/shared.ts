import type { MediaInfo, VideoSource } from '../index'

/** Canonical source/container helpers for the built-in HTML and AVPlay backends. */
export function normalizeSource(source: string | VideoSource): VideoSource {
  return typeof source === 'string' ? { uri: source } : source
}

export function inferContainer(uri: string): string | undefined {
  const match = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(uri)
  return match?.[1]?.toLowerCase()
}

/** A fresh media record; callers mutate their own instance. */
export function emptyMediaInfo(): MediaInfo {
  return { seekable: true, live: false, tracks: [], chapters: [] }
}