/** DOM overlays protected from the native video's aperture. */
export const VIDEO_CONTROLS_ATTRIBUTE = 'data-viptv-video-controls';
export type VideoControlsTarget = HTMLElement;
export function registerVideoControls(element: VideoControlsTarget): () => void {
  const previous = element.getAttribute(VIDEO_CONTROLS_ATTRIBUTE);
  element.setAttribute(VIDEO_CONTROLS_ATTRIBUTE, '');
  return () => {
    if (previous === null) element.removeAttribute(VIDEO_CONTROLS_ATTRIBUTE);
    else element.setAttribute(VIDEO_CONTROLS_ATTRIBUTE, previous);
  };
}
