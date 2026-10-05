import { afterEach, expect, it, vi } from "vitest";
import { NativeSurfaceCompositor } from "../src/tauri-native/native-surface-compositor";
let compositor: NativeSurfaceCompositor | undefined;
afterEach(() => {
  compositor?.release();
  compositor = undefined;
  document.body.replaceChildren();
});
function picture() {
  document.body.innerHTML =
    "<style>html,body {overflow:hidden} body {background:black} main {position:absolute;overflow:hidden;background:black}</style><main><video></video></main>";
  const main = document.querySelector("main")!;
  const anchor = document.querySelector("video")!;
  const rect = new DOMRect(0, 0, 640, 360);
  vi.spyOn(main, "getBoundingClientRect").mockReturnValue(rect);
  vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue(rect);
  return anchor;
}
it("uses the viewport when the absolutely positioned app leaves a zero-height body", () => {
  const anchor = picture();
  compositor = new NativeSurfaceCompositor("viewport-test", anchor);
  const frame = compositor.measure({ x: 0, y: 0, width: 640, height: 360 }, 1);
  expect(frame.bounds).toEqual({ left: 0, top: 0, right: 640, bottom: 360 });
});
it("keeps protected feedback visible through compositor refreshes", () => {
  const anchor = picture();
  const toast = document.createElement("div");
  toast.setAttribute("data-viptv-video-controls", "");
  toast.textContent = "Track unavailable";
  document.body.append(toast);
  vi.spyOn(toast, "getBoundingClientRect").mockReturnValue(
    new DOMRect(20, 20, 300, 80),
  );
  compositor = new NativeSurfaceCompositor("feedback-test", anchor);
  for (let i = 0; i < 3; i++) {
    compositor.refresh();
    const frame = compositor.measure(
      { x: 0, y: 0, width: 640, height: 360 },
      1,
    );
    compositor.commit(frame);
    expect(frame.occluders.some((item) => item.element === toast)).toBe(false);
  }
  expect(toast.style.getPropertyValue("--tauri-native-video-mask-image")).toBe(
    "",
  );
  expect(toast.textContent).toBe("Track unavailable");
});
