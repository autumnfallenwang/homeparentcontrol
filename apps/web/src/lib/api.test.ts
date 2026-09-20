import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apiBaseUrl, contract } from "./api";

// vitest runs in the node environment, so `window` is undefined and every case
// below exercises the server (SSR) branch. The browser branch is one line and
// is covered by the same precedence rules minus API_URL.
describe("apiBaseUrl (server context)", () => {
  const saved = { API_URL: process.env.API_URL, NEXT: process.env.NEXT_PUBLIC_API_URL };

  // `delete`, not `= undefined`: assigning undefined to process.env coerces to
  // the *string* "undefined", which is truthy, so `??` would never fall through.
  beforeEach(() => {
    delete process.env.API_URL;
    delete process.env.NEXT_PUBLIC_API_URL;
  });

  afterEach(() => {
    if (saved.API_URL === undefined) delete process.env.API_URL;
    else process.env.API_URL = saved.API_URL;
    if (saved.NEXT === undefined) delete process.env.NEXT_PUBLIC_API_URL;
    else process.env.NEXT_PUBLIC_API_URL = saved.NEXT;
  });

  it("prefers API_URL — in-cluster Service DNS beats the public ingress for SSR", () => {
    process.env.API_URL = "http://homeparentcontrol-api";
    process.env.NEXT_PUBLIC_API_URL = "http://hpc-api.arch.internal";
    expect(apiBaseUrl()).toBe("http://homeparentcontrol-api");
  });

  it("falls back to NEXT_PUBLIC_API_URL when API_URL is unset", () => {
    process.env.NEXT_PUBLIC_API_URL = "http://hpc-api.arch.internal";
    expect(apiBaseUrl()).toBe("http://hpc-api.arch.internal");
  });

  it("falls back to the local dev port when neither is set", () => {
    expect(apiBaseUrl()).toBe("http://localhost:3001");
  });
});

describe("@hpc/contract resolution", () => {
  // This is what phase 0 exists to prove: the workspace package resolves from
  // the web app, including its `.js` import specifiers pointing at `.ts` source.
  it("re-exports the contract version from the workspace package", () => {
    expect(contract.major).toMatch(/^\/v\d+$/);
    expect(typeof contract.minor).toBe("number");
  });
});
