/* 一覧の3・6列切替ボタン(.density-toggle)。/box一覧・/team一覧・ダメ計の
   「ボックスから選択」「チームから選択」モーダルで同じアイコン・aria-labelを使う。 */

export type DisplayDensityMode = "expanded" | "compressed";

/** /box一覧とダメ計「ボックスから選択」モーダルで共有するボックス表示密度の保存キー。 */
export const BOX_DISPLAY_DENSITY_STORAGE_KEY = "poke-guide:box-display-density";

const DENSITY_ICON_EXPANDED = `<svg class="density-toggle-icon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="4" width="5" height="5" rx="1"/><rect x="10" y="4" width="5" height="5" rx="1"/><rect x="18" y="4" width="5" height="5" rx="1"/><rect x="2" y="12" width="5" height="5" rx="1"/><rect x="10" y="12" width="5" height="5" rx="1"/><rect x="18" y="12" width="5" height="5" rx="1"/></svg>`;
const DENSITY_ICON_COMPRESSED = `<svg class="density-toggle-icon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="10" width="5" height="5" rx="1"/><rect x="10" y="10" width="5" height="5" rx="1"/><rect x="18" y="10" width="5" height="5" rx="1"/></svg>`;

/** ボタンのアイコン・data-mode・aria-labelを現在のモードに合わせる。 */
export function updateDensityToggleButton(
  button: HTMLButtonElement,
  mode: DisplayDensityMode,
): void {
  button.dataset.mode = mode;
  button.innerHTML = mode === "expanded" ? DENSITY_ICON_EXPANDED : DENSITY_ICON_COMPRESSED;
  button.setAttribute(
    "aria-label",
    mode === "expanded" ? "圧縮表示に切り替える" : "展開表示に切り替える",
  );
}

export function toggleDensityMode(mode: DisplayDensityMode): DisplayDensityMode {
  return mode === "expanded" ? "compressed" : "expanded";
}

/** localStorageに保存した表示密度を読む。使えない環境では展開表示を既定にする。 */
export function loadDensityMode(storageKey: string): DisplayDensityMode {
  try {
    return window.localStorage.getItem(storageKey) === "compressed" ? "compressed" : "expanded";
  } catch {
    return "expanded";
  }
}

/** 保存できなくても、現在開いているページでの切り替えは維持する。 */
export function saveDensityMode(storageKey: string, mode: DisplayDensityMode): void {
  try {
    window.localStorage.setItem(storageKey, mode);
  } catch {
    // noop
  }
}
