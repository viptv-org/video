export interface NativeLayout {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const LAYOUT_VARIABLES = [
  '--tauri-native-video-left',
  '--tauri-native-video-top',
  '--tauri-native-video-right',
  '--tauri-native-video-bottom',
  '--tauri-native-video-width',
  '--tauri-native-video-height',
] as const;

/**
 * Makes the DOM stack above the anchor transparent so the native surface
 * shows through the WebView aperture, and hides the anchor itself. This is
 * the honest MVP aperture: unlike the plugin's own compositor it does not
 * reconstruct the original backgrounds around the video rectangle, so the
 * surrounding page shows the native black floor while a session is live.
 */
export class NativeAperture {
  private aperture: Array<{ element: HTMLElement; background: string }> = [];
  private savedAnchorVisibility: string | undefined;

  constructor(private readonly anchor: HTMLVideoElement) {}

  open(layout: NativeLayout | undefined): void {
    if (this.savedAnchorVisibility === undefined) {
      this.savedAnchorVisibility = this.anchor.style.visibility;
      this.anchor.style.visibility = 'hidden';
    }
    const saved: Array<{ element: HTMLElement; background: string }> = [];
    for (let element = this.anchor.parentElement; element instanceof HTMLElement; element = element.parentElement) {
      saved.push({ element, background: element.style.background });
      element.style.background = 'transparent';
    }
    this.aperture = saved;
    if (layout) this.publish(layout);
  }

  close(): void {
    for (const { element, background } of this.aperture) element.style.background = background;
    this.aperture = [];
    if (this.savedAnchorVisibility !== undefined) {
      this.anchor.style.visibility = this.savedAnchorVisibility;
      this.savedAnchorVisibility = undefined;
    }
    const root = document.documentElement;
    root.classList.remove('tauri-native-video');
    for (const name of LAYOUT_VARIABLES) root.style.removeProperty(name);
  }

  publish(layout: NativeLayout): void {
    const root = document.documentElement;
    root.classList.add('tauri-native-video');
    root.style.setProperty('--tauri-native-video-left', `${layout.x}px`);
    root.style.setProperty('--tauri-native-video-top', `${layout.y}px`);
    root.style.setProperty('--tauri-native-video-right', `${layout.x + layout.width}px`);
    root.style.setProperty('--tauri-native-video-bottom', `${layout.y + layout.height}px`);
    root.style.setProperty('--tauri-native-video-width', `${layout.width}px`);
    root.style.setProperty('--tauri-native-video-height', `${layout.height}px`);
  }
}
