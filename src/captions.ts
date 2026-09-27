import { sessionMediaFetch } from './session-media-fetch';
import type { PlayerTrack } from './types';

export interface CaptionCue { start: number; end: number; text: string; }
const clock = (s: string) => (s.startsWith('-') ? -1 : 1) * s.replace(/^-/, '').split(':').reduce((total, part) => total * 60 + Number(part), 0);
const cueText = (value: string) => value.replace(/<[^>]*>/g, '').replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, entity: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' }[entity]!));
/** Plain cue text is rendered as text, never inserted as HTML. */
export function parseWebVtt(text: string, offset = 0): CaptionCue[] {
  const cues: CaptionCue[] = [];
  const map = text.match(/X-TIMESTAMP-MAP=LOCAL:([^,\r\n]+),MPEGTS:(\d+)/);
  if (map) offset += Number(map[2]) / 90000 - clock(map[1]);
  for (const block of text.replace(/\r/g, '').split(/\n\s*\n/)) {
    const lines = block.split('\n');
    const index = lines.findIndex(line => line.includes(' --> '));
    if (index < 0) continue;
    const times = lines[index].match(/(-?[\d:.]+)\s+-->\s+(-?[\d:.]+)/);
    if (!times) continue;
    const start = clock(times[1]) + offset, end = clock(times[2]) + offset;
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) cues.push({ start, end, text: cueText(lines.slice(index + 1).join('\n')).slice(0, 4096) });
    if (cues.length >= 4096) break;
  }
  return cues;
}

/** Caption extraction is requested only when the viewer opens the subtitle list. */
export class BrowserCaptions {
  private tracks: PlayerTrack[] = [];
  private selected: string | null = null;
  private cues: CaptionCue[] = [];
  private block = -1;
  private generation = 0;
  private loading = false;
  private abort = new AbortController();
  private readonly base: URL;
  private readonly fetch: typeof fetch;
  constructor(url: string, private readonly changed: (tracks: PlayerTrack[], selected: string | null, captions: string[]) => void) {
    this.base = new URL('.', url); this.fetch = sessionMediaFetch(url);
  }
  async discover(): Promise<void> {
    if (this.tracks.length) return;
    const token = this.generation;
    const response = await this.fetch(new URL('tracks.json', this.base), { signal: this.abort.signal });
    const result = await response.json() as { subtitles?: Array<{ input_index: number; title: string; language?: string; supported: boolean }> };
    if (token !== this.generation || this.abort.signal.aborted) return;
    this.tracks = (result.subtitles ?? []).slice(0, 32).map(t => ({ id: `subtitle:${t.input_index}`, label: t.title || t.language || `Subtitle ${t.input_index + 1}`, language: t.language, available: t.supported }));
    this.changed(this.tracks, this.selected, []);
  }
  async select(id: string | null, position: number): Promise<void> {
    if (id && !this.tracks.some(t => t.id === id && t.available)) throw new Error('Subtitle is unavailable.');
    this.generation++; this.selected = id; this.cues = []; this.block = -1;
    this.changed(this.tracks, id, []); if (id) await this.load(position);
  }
  tick(position: number): void {
    if (!this.selected) return;
    if (Math.floor(position / 60) !== this.block && !this.loading) void this.load(position).catch(() => { this.changed(this.tracks, this.selected, []); });
    this.changed(this.tracks, this.selected, this.cues.filter(c => c.start <= position && position < c.end).map(c => c.text));
  }
  private async load(position: number): Promise<void> {
    if (!this.selected) return;
    const token = this.generation, id = this.selected.split(':')[1]; this.loading = true; this.block = Math.floor(position / 60);
    try {
      const response = await this.fetch(new URL(`subtitle-${id}.vtt`, this.base), { headers: { 'x-viptv-subtitle-position': String(Math.max(0, position)) }, signal: this.abort.signal });
      const text = await response.text();
      if (token !== this.generation || text.length > 2 * 1024 * 1024) return;
      this.cues = parseWebVtt(text, Number(response.headers.get('X-VIPTV-Subtitle-Offset') ?? 0)); this.block = Math.floor(position / 60);
    } finally { this.loading = false; }
  }
  dispose(): void { this.generation++; this.abort.abort(); this.cues = []; }
}
