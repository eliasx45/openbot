import { createSignal } from "solid-js";

/**
 * Fork: the Contrast slider. 0 is upstream's look. Upward, `fork-contrast.css` makes the gray text
 * and the lines stronger, and `window-glass.css` makes the transparent window's tint more solid
 * (frame 20 % → 100 %, card 45 % → 100 %, as Codync's dark window). Both read
 * `--window-glass-contrast` (0–1). The value is a preference of this computer's main window only, so
 * it stays in browser storage and needs no main-process setting.
 */
const STORAGE_KEY = "openbot.fork.glassContrast";
const CONTRAST_PROPERTY = "--window-glass-contrast";
export const GLASS_CONTRAST_MIN = 0;
export const GLASS_CONTRAST_MAX = 100;
const DEFAULT_GLASS_CONTRAST = 0;

function clampContrast(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_GLASS_CONTRAST;
  return Math.min(GLASS_CONTRAST_MAX, Math.max(GLASS_CONTRAST_MIN, Math.round(value)));
}

/** Reading `window.localStorage` throws when the browser blocks storage, so it is read inside the guard. */
function readContrast(): number {
  try {
    const text = window.localStorage.getItem(STORAGE_KEY);
    return text === null ? DEFAULT_GLASS_CONTRAST : clampContrast(Number(text));
  } catch {
    return DEFAULT_GLASS_CONTRAST;
  }
}

function saveContrast(value: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    // The value still applies until the window reloads.
  }
}

function applyContrast(value: number): void {
  document.documentElement.style.setProperty(CONTRAST_PROPERTY, String(value / GLASS_CONTRAST_MAX));
}

const [contrast, setContrast] = createSignal(DEFAULT_GLASS_CONTRAST);

/** Applies the saved contrast before the first paint. Only the main window has the glass. */
export function syncGlassContrast(): void {
  const saved = readContrast();
  setContrast(saved);
  applyContrast(saved);
}

/** The Settings slider: each step applies at once, and the release saves it. */
export function useGlassContrastChoice() {
  const change = (value: number) => {
    const next = clampContrast(value);
    setContrast(next);
    applyContrast(next);
  };
  const changeEnd = (value: number) => {
    change(value);
    saveContrast(clampContrast(value));
  };
  return { contrast, change, changeEnd };
}
