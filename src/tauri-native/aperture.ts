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
  private savedAnchorVisibility?: string;
  constructor(private readonly anchor: HTMLVideoElement) {}
  open(layout: NativeLayout | undefined): void {
    this.close();
    this.savedAnchorVisibility = this.anchor.style.visibility;
    this.anchor.style.visibility = 'hidden';
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
    if (this.savedAnchorVisibility !== undefined) {
      this.anchor.style.visibility = this.savedAnchorVisibility;
      this.savedAnchorVisibility = undefined;
    }
  }
  publish(layout: NativeLayout): void {
    const frame = this.compositor?.measure(layout, 1);
    if (frame) this.compositor?.commit(frame);
  }
}
