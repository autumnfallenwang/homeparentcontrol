"use client";

import { useEffect } from "react";
import { APPEARANCE_EVENT, applyAppearance, readMode, readSize } from "../lib/theme.js";

/**
 * Keeps `<html>` in step with the Appearance preferences after the first
 * paint: when Settings › Appearance writes one, and when the OS flips between
 * light and dark while the mode is "System". The first paint itself is the
 * boot script's job (`APPEARANCE_BOOT_SCRIPT`). Renders nothing.
 */
export function ThemeProvider() {
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => applyAppearance(readMode(), readSize(), media.matches);
    apply();
    media.addEventListener("change", apply);
    window.addEventListener(APPEARANCE_EVENT, apply);
    // Another tab changed it — a parent adjusting size on the laptop while
    // the same browser has a second window open.
    window.addEventListener("storage", apply);
    return () => {
      media.removeEventListener("change", apply);
      window.removeEventListener(APPEARANCE_EVENT, apply);
      window.removeEventListener("storage", apply);
    };
  }, []);
  return null;
}
