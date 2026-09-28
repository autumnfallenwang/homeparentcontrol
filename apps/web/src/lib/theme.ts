/**
 * Appearance: light / dark / system, and a size — homework's Appearance tab,
 * minus its extra palettes.
 *
 * ⚠️ **Per browser, not per account.** The kitchen tablet and a parent's
 * laptop can differ, and nothing here is worth a server round-trip or a row
 * another parent could change. Stored in `localStorage`, read by the boot
 * script below before the first paint and by `ThemeProvider` afterwards.
 */

export type ThemeMode = "light" | "dark" | "system";

export const MODE_KEY = "hpc.appearance.mode";
export const SIZE_KEY = "hpc.appearance.size";
/** Fired on `window` after either preference is written. */
export const APPEARANCE_EVENT = "hpc-appearance-change";

export const SIZE_MIN = 0.8;
export const SIZE_MAX = 1.6;
export const SIZE_DEFAULT = 1;

export const SIZE_PRESETS: readonly { value: number; label: string }[] = [
  { value: 1, label: "Small" },
  { value: 1.15, label: "Medium" },
  { value: 1.3, label: "Large" },
];

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === "light" || value === "dark" || value === "system";
}

export function resolveMode(mode: ThemeMode, systemPrefersDark: boolean): "light" | "dark" {
  if (mode === "system") return systemPrefersDark ? "dark" : "light";
  return mode;
}

/** A stored size, clamped; anything unreadable is the default. */
export function parseSize(raw: unknown): number {
  if (typeof raw !== "string") return SIZE_DEFAULT;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return SIZE_DEFAULT;
  return Math.min(SIZE_MAX, Math.max(SIZE_MIN, value));
}

export function sameSize(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.001;
}

/**
 * Runs in `<head>` before the page paints, so a dark-mode viewer never sees
 * a white flash. homework applies its theme in an effect after hydration and
 * flashes on every load; on a tablet by a bed at night that is the one
 * moment it matters.
 *
 * ⚠️ Plain ES5 in a string, and every failure swallowed: storage can throw in
 * a private window, and a theme is never worth a broken page.
 */
export const APPEARANCE_BOOT_SCRIPT = `(function(){try{var d=document.documentElement;var m=localStorage.getItem(${JSON.stringify(MODE_KEY)});var dark=m==="dark"||((m===null||m==="system")&&window.matchMedia("(prefers-color-scheme: dark)").matches);d.classList.toggle("dark",dark);var s=parseFloat(localStorage.getItem(${JSON.stringify(SIZE_KEY)})||"");if(isFinite(s)){d.style.setProperty("--font-scale",String(Math.min(${SIZE_MAX},Math.max(${SIZE_MIN},s))));}}catch(e){}})();`;

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function readMode(): ThemeMode {
  const raw = read(MODE_KEY);
  return isThemeMode(raw) ? raw : "system";
}

export function readSize(): number {
  return parseSize(read(SIZE_KEY));
}

export function writeAppearance(key: typeof MODE_KEY | typeof SIZE_KEY, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private window or blocked storage: it applies now, just not next time.
  }
  window.dispatchEvent(new Event(APPEARANCE_EVENT));
}

/** Apply both preferences to `<html>`. */
export function applyAppearance(mode: ThemeMode, size: number, systemPrefersDark: boolean): void {
  const root = document.documentElement;
  root.classList.toggle("dark", resolveMode(mode, systemPrefersDark) === "dark");
  root.style.setProperty("--font-scale", String(size));
}
