"use client";

import { useEffect, useState } from "react";
import {
  MODE_KEY,
  readMode,
  readSize,
  SIZE_KEY,
  SIZE_MAX,
  SIZE_MIN,
  SIZE_PRESETS,
  sameSize,
  type ThemeMode,
  writeAppearance,
} from "../../lib/theme.js";
import { Page, SectionTitle } from "../shell/page.js";
import { Card, inputClass, SegmentedControl } from "../ui.js";

/**
 * Settings › Appearance — homework's Mode and Size, without its extra
 * palettes. Saved in this browser only (see `lib/theme.ts`).
 */
export function AppearanceSettings() {
  const [mode, setMode] = useState<ThemeMode>("system");
  const [size, setSize] = useState(1);
  const [custom, setCustom] = useState("100");

  // Storage is only readable in the browser, so the real values arrive
  // after mount; the boot script has already applied them to the page.
  useEffect(() => {
    setMode(readMode());
    const stored = readSize();
    setSize(stored);
    setCustom(String(Math.round(stored * 100)));
  }, []);

  const applySize = (next: number) => {
    setSize(next);
    setCustom(String(Math.round(next * 100)));
    writeAppearance(SIZE_KEY, String(next));
  };

  const commitCustom = () => {
    const percent = Number.parseFloat(custom);
    if (!Number.isFinite(percent)) {
      setCustom(String(Math.round(size * 100)));
      return;
    }
    applySize(Math.min(SIZE_MAX, Math.max(SIZE_MIN, percent / 100)));
  };

  const preset = SIZE_PRESETS.find((option) => sameSize(option.value, size));

  return (
    <Page
      title="Appearance"
      subtitle="Saved in this browser only — the tablet and your laptop can differ."
    >
      <Card>
        <SectionTitle>Mode</SectionTitle>
        <p className="mt-1 text-sm text-muted-foreground">
          System follows this device's light or dark setting as it changes.
        </p>
        <div className="mt-3 max-w-md">
          <SegmentedControl
            label="Mode"
            value={mode}
            options={[
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
              { value: "system", label: "System" },
            ]}
            onChange={(next) => {
              setMode(next);
              writeAppearance(MODE_KEY, next);
            }}
          />
        </div>
      </Card>

      <Card>
        <SectionTitle>Size</SectionTitle>
        <p className="mt-1 text-sm text-muted-foreground">
          Scales everything together — text, buttons and spacing.
        </p>
        <div className="mt-3 max-w-md">
          <SegmentedControl
            label="Size"
            value={preset ? String(preset.value) : "custom"}
            options={SIZE_PRESETS.map((option) => ({
              value: String(option.value),
              label: option.label,
            }))}
            onChange={(next) => applySize(Number(next))}
          />
        </div>
        <div className="mt-3 flex items-center gap-2 text-sm">
          <label htmlFor="size-custom" className="text-muted-foreground">
            Custom
          </label>
          <input
            id="size-custom"
            type="number"
            min={Math.round(SIZE_MIN * 100)}
            max={Math.round(SIZE_MAX * 100)}
            step={5}
            value={custom}
            onChange={(event) => setCustom(event.target.value)}
            onBlur={commitCustom}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitCustom();
              }
            }}
            className={inputClass.replace("w-full", "w-24")}
          />
          <span className="text-muted-foreground">%</span>
        </div>
      </Card>
    </Page>
  );
}
