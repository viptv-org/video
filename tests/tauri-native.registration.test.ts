import { describe, expect, it } from 'vitest';

import { createPlayer } from '../src';

describe('Tauri player registration', () => {
  it('registers the native adapter only inside the Tauri runtime', () => {
    const anchor = document.createElement('video');
    expect(() => createPlayer({ platform: 'tauri', video: anchor }))
      .toThrow(/unavailable outside the desktop app/);

    const scoped = window as typeof window & { __TAURI_INTERNALS__?: unknown };
    scoped.__TAURI_INTERNALS__ = {};
    try {
      const player = createPlayer({ platform: 'tauri', video: anchor });
      expect(player.capabilities.platform).toBe('tauri');
      expect(player.capabilities.engine).toContain('tauri-plugin-video');
    } finally {
      delete scoped.__TAURI_INTERNALS__;
    }
  });

  it('keeps the browser engine unchanged outside Tauri', () => {
    const video = document.createElement('video');
    const canvas = document.createElement('canvas');
    const player = createPlayer({ platform: 'html5', video, canvas });
    expect(player.capabilities.platform).toBe('html5');
  });
});
