import { describe, expect, it } from "vitest";
import {
  APPEARANCE_BOOT_SCRIPT,
  MODE_KEY,
  parseSize,
  resolveMode,
  SIZE_DEFAULT,
  SIZE_KEY,
  SIZE_MAX,
  SIZE_MIN,
} from "./theme.js";

describe("resolveMode", () => {
  it("follows the system only when asked to", () => {
    expect(resolveMode("system", true)).toBe("dark");
    expect(resolveMode("system", false)).toBe("light");
    expect(resolveMode("light", true)).toBe("light");
    expect(resolveMode("dark", false)).toBe("dark");
  });
});

describe("parseSize", () => {
  it("clamps, and treats anything unreadable as the default", () => {
    expect(parseSize("1.3")).toBe(1.3);
    expect(parseSize("9")).toBe(SIZE_MAX);
    expect(parseSize("0.1")).toBe(SIZE_MIN);
    expect(parseSize("big")).toBe(SIZE_DEFAULT);
    expect(parseSize(null)).toBe(SIZE_DEFAULT);
  });
});

/** Run the boot script against a fake `<html>` and storage. */
function boot(stored: Record<string, string>, systemDark: boolean, throws = false) {
  const classes = new Set<string>();
  const style: Record<string, string> = {};
  const document = {
    documentElement: {
      classList: {
        toggle: (name: string, on: boolean) => (on ? classes.add(name) : classes.delete(name)),
      },
      style: { setProperty: (name: string, value: string) => (style[name] = value) },
    },
  };
  const localStorage = {
    getItem: (key: string) => {
      if (throws) throw new Error("SecurityError");
      return stored[key] ?? null;
    },
  };
  const window = { matchMedia: () => ({ matches: systemDark }) };
  new Function("document", "localStorage", "window", APPEARANCE_BOOT_SCRIPT)(
    document,
    localStorage,
    window,
  );
  return { dark: classes.has("dark"), scale: style["--font-scale"] };
}

describe("the boot script — applied before the first paint", () => {
  it("★ applies a stored dark mode and size", () => {
    expect(boot({ [MODE_KEY]: "dark", [SIZE_KEY]: "1.3" }, false)).toEqual({
      dark: true,
      scale: "1.3",
    });
  });

  it("follows the system when nothing is stored", () => {
    expect(boot({}, true).dark).toBe(true);
    expect(boot({}, false).dark).toBe(false);
  });

  it("an explicit light mode beats a dark system", () => {
    expect(boot({ [MODE_KEY]: "light" }, true).dark).toBe(false);
  });

  it("clamps a size written by hand", () => {
    expect(boot({ [SIZE_KEY]: "5" }, false).scale).toBe(String(SIZE_MAX));
  });

  it("★ storage that throws leaves the page alone rather than breaking it", () => {
    expect(() => boot({}, true, true)).not.toThrow();
  });
});
