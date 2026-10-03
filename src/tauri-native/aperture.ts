import { NativeSurfaceCompositor } from './native-surface-compositor';

export interface NativeLayout {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Preserve upstream background reconstruction and protected video overlays. */
export class NativeAperture {
  private compositor?: NativeSurfaceCompositor;
  constructor(private readonly anchor: HTMLVideoElement) {}
  open(layout: NativeLayout | undefined): void {
    this.close();
    this.compositor = new NativeSurfaceCompositor(crypto.randomUUID(), this.anchor);
    if (layout) this.publish(layout);
  }
  observe(invalidated: (backgroundChanged: boolean) => void): () => void {
    return this.compositor?.observe(invalidated) ?? (() => undefined);
  }
  refresh(): void { this.compositor?.refresh(); }
  close(): void {
    this.compositor?.release();
    this.compositor = undefined;
  }
  publish(layout: NativeLayout): void {
    const frame = this.compositor?.measure(layout, 1);
    if (frame) this.compositor?.commit(frame);
  }
}
