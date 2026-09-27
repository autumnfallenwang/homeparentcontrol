import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ★ Every `fetch` in the web app must go to the API ORIGIN.
 *
 * The UI and the API are two hosts (`homeparentcontrol.arch.internal` and
 * `homeparentcontrol-api.arch.internal`). A relative `fetch("/api/…")`
 * resolves against the page — the web origin — where Next.js answers 404.
 * The rules page did exactly that for its device lookup, returned early on the
 * 404 in silence, and so could save a draft but never publish one. Nothing
 * failed: the API tests call the API directly, and locally both origins can be
 * the same host, which hides it completely.
 *
 * The rule is structural rather than a list of bad paths: the first argument
 * of every `fetch(` must begin with `${apiBaseUrl()}`.
 */
const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..");

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) found.push(path);
  }
  return found;
}

const withoutComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

/** Every `fetch(` call site, with the start of its first argument. */
function fetchCalls(code: string): string[] {
  return [...code.matchAll(/\bfetch\(\s*(\S{0,20})/g)].map((match) => match[1] ?? "");
}

// biome-ignore lint/suspicious/noTemplateCurlyInString: the SOURCE text being matched, not a template
const ALLOWED_PREFIX = "`${apiBaseUrl()}";

describe("every fetch targets the API origin", () => {
  it("recognises the shape that broke the rules page", () => {
    // Falsification in-file: the guard must see the original bug.
    const [bug] = fetchCalls('await fetch("/api/parent/v1/devices", {})');
    expect(bug?.startsWith('"/api/')).toBe(true);
    expect(bug?.startsWith(ALLOWED_PREFIX)).toBe(false);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test, not a template
    expect(fetchCalls("await fetch(`${apiBaseUrl()}/x`)")[0]?.startsWith(ALLOWED_PREFIX)).toBe(
      true,
    );
  });

  const files = sourceFiles(srcRoot).map((path) => ({
    path: path.slice(srcRoot.length + 1),
    code: withoutComments(readFileSync(path, "utf8")),
  }));

  it("found the files it is guarding", () => {
    // A guard that scans nothing passes for ever.
    expect(files.some((file) => file.path.endsWith("parent-api.ts"))).toBe(true);
    expect(files.flatMap((file) => fetchCalls(file.code)).length).toBeGreaterThanOrEqual(4);
  });

  for (const file of files) {
    for (const target of fetchCalls(file.code)) {
      it(`${file.path}: fetch(${target}…)`, () => {
        expect(target.startsWith(ALLOWED_PREFIX)).toBe(true);
      });
    }
  }
});
