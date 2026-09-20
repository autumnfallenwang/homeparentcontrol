import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ★ A source-level guard: no page may re-type a load-bearing sentence.
 *
 * §5.8 names four wordings that are load-bearing, and they live in
 * `@hpc/contract` so the API and the UI cannot drift. That only holds while
 * every page *imports* them. The failure this catches is mundane and very
 * likely: someone adds a page, wants the reassurance line, and types it —
 * slightly differently. Two nearly-identical sentences then both look right,
 * and only one gets fixed when the phrasing is improved.
 *
 * ⚠️ This asserts on SOURCE text, which is unusual and deliberate. The
 * alternative is rendering every page and diffing strings, which needs a DOM
 * and would still miss a page nobody thought to render.
 */
const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..");

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (/\.tsx?$/.test(entry) && !entry.endsWith(".test.ts")) {
      found.push(path);
    }
  }
  return found;
}

/**
 * ⚠️ Comments are stripped before scanning, and that distinction is the
 * point: a comment **explaining** that there is no "disable enforcement"
 * control is exactly what should exist. Only code and rendered text are
 * checked. (Found by this test failing on its own file's header, which is a
 * fair result — the first version could not tell prose from a control.)
 */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

const files = sourceFiles(srcRoot).map((path) => ({
  path: path.slice(srcRoot.length + 1),
  text: readFileSync(path, "utf8"),
  code: withoutComments(readFileSync(path, "utf8")),
}));

/** Distinctive fragments of each of the four. */
const FORBIDDEN_LITERALS: { fragment: string; why: string }[] = [
  {
    fragment: "still enforcing the rules from",
    why: "§4.6's still-enforcing banner — import healthPhrasing",
  },
  {
    fragment: "won't wake the Mac for her",
    why: "§3.5's no-unlock sentence — import LATE_GRANT_DOES_NOT_UNLOCK",
  },
  {
    fragment: "keeps enforcing bedtime",
    why: "§5.5's Revoke description — import REVOKE",
  },
  {
    fragment: "stops enforcing anything",
    why: "§5.5's Decommission description — import DECOMMISSION",
  },
  {
    fragment: "not minutes it was switched on",
    why: "§5.8's active_s label — import ACTIVE_TIME_EXPLANATION",
  },
  {
    fragment: "is NOT enforcing bedtime",
    why: "§6.5's shadow-mode line — import shadowModeNotEnforcing",
  },
];

describe("the four load-bearing wordings", () => {
  it("the scan actually reads files — otherwise every test below is vacuous", () => {
    expect(files.length).toBeGreaterThan(8);
    expect(files.some((file) => file.path.includes("page.tsx"))).toBe(true);
  });

  for (const { fragment, why } of FORBIDDEN_LITERALS) {
    it(`★ no file hardcodes "${fragment}"`, () => {
      const offenders = files.filter((file) => file.code.includes(fragment));
      expect(
        offenders.map((file) => file.path),
        `hardcoded instead of imported — ${why}`,
      ).toEqual([]);
    });
  }

  // ⚠️ The positive half. The guard above would also pass if the UI simply
  // never showed these at all, which is the other way to get it wrong.
  it("★ the components that need them DO import them", () => {
    const card = files.find((file) => file.path.endsWith("health-card.tsx"));
    expect(card?.text).toContain("healthPhrasing");
    expect(card?.text).toContain("ACTIVE_TIME_EXPLANATION");

    const grant = files.find((file) => file.path.endsWith("grant-buttons.tsx"));
    expect(grant?.text).toContain("LATE_GRANT_DOES_NOT_UNLOCK");

    const device = files.find((file) => file.path.includes("devices"));
    expect(device?.text).toContain("REVOKE");
    expect(device?.text).toContain("DECOMMISSION");

    // ★ §6.5 — the card must actually render the shadow line, not merely
    // avoid hardcoding it.
    expect(card?.text).toContain("shadowModeNotEnforcing");
  });
});

describe("what must not exist anywhere in the UI", () => {
  /**
   * ⚠️ "What is deliberately absent from the UI — and there is no route to
   * delete later, because there is no route: **no child-facing surface of
   * any kind** … and **no 'disable enforcement' button**."
   */
  it("★ there is no 'disable enforcement' control in any spelling", () => {
    const patterns = [
      /disable\s+enforcement/i,
      /enforcement[_-]?enabled/i,
      /turn\s+off\s+enforcement/i,
      /stop\s+enforcing\s+for/i,
    ];
    for (const file of files) {
      for (const pattern of patterns) {
        expect(pattern.test(file.code), `${file.path} matches ${pattern}`).toBe(false);
      }
    }
  });

  // C1/X7 — T4's "Ask for more time" button is withdrawn. She asks in person.
  it("★ there is no child-facing request affordance", () => {
    for (const file of files) {
      expect(/ask\s+for\s+more\s+time/i.test(file.code), file.path).toBe(false);
    }
  });
});

/**
 * ★ P2.6 — "there is no mobile app and never will be."
 *
 * Every parent surface is this app in a browser, and the page that settles
 * an argument is opened on a phone while someone waits. Two things break
 * that, both silently:
 *
 * - **No viewport tag.** iOS renders at 980px and scales down, which makes a
 *   44px button about 15px tall. The page still "works"; it is just
 *   unusable one-handed.
 * - **Touch targets under 44px.** 📄 Apple's HIG minimum. Below it, the
 *   grant buttons get mis-tapped, and a mis-tap here grants the wrong
 *   amount of time.
 */
/** One top-level declaration, from its `export` to the next one. */
function declaration(source: string | undefined, start: string): string {
  if (!source) return "";
  const from = source.indexOf(start);
  if (from < 0) return "";
  const rest = source.slice(from + start.length);
  const next = rest.indexOf("\nexport ");
  return start + (next < 0 ? rest : rest.slice(0, next));
}

describe("phone width", () => {
  const layout = files.find((file) => file.path.endsWith("app/layout.tsx"));
  const ui = files.find((file) => file.path.endsWith("components/ui.tsx"));

  it("★ the root layout declares a viewport", () => {
    expect(layout?.code).toContain("export const viewport");
    expect(layout?.code).toContain('width: "device-width"');
  });

  it("★ every interactive control is at least 44px tall", () => {
    // min-h-11 is 11 × 0.25rem = 2.75rem = 44px.
    expect(ui?.code).toContain("min-h-11");
    // ⚠️ Slice to the NEXT top-level export, not to the first `\n}` — a
    // destructured parameter list closes with a brace at column 0, so the
    // obvious regex matched only the signature and the assertion passed on
    // whatever came next. (It failed honestly here, which is how this was
    // found.)
    expect(declaration(ui?.code, "export function Button")).toContain("min-h-11");
    expect(declaration(ui?.code, "export const inputClass")).toContain("min-h-11");
  });

  it("★ no page is laid out for a desktop-only width", () => {
    for (const file of files.filter((item) => item.path.includes("app/"))) {
      // A fixed pixel width, or a grid that is multi-column at every size,
      // is what breaks below 400px.
      expect(/\bw-\[\d{3,}px\]/.test(file.code), file.path).toBe(false);
      expect(/className="[^"]*\bgrid-cols-[3-9]\b/.test(file.code), file.path).toBe(false);
    }
  });
});
