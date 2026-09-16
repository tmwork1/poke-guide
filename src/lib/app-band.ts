/** Viewport coordinates for the centered mobile application band. */
export function getAppBandRect(): DOMRect {
  const shell = document.querySelector<HTMLElement>(".app-shell");
  return shell?.getBoundingClientRect()
    ?? new DOMRect(0, 0, window.innerWidth, window.innerHeight);
}

/** Keep a fixed popover inside the app band while preserving its anchor. */
export function clampToAppBand(preferredLeft: number, elementWidth: number, gutter = 8): number {
  const band = getAppBandRect();
  return Math.max(
    band.left + gutter,
    Math.min(band.right - elementWidth - gutter, preferredLeft),
  );
}
