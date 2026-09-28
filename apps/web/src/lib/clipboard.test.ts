import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard.js";

/** A fake page: secure or not, with or without the Clipboard API. */
function page({ secure, clipboard }: { secure: boolean; clipboard: boolean }) {
  const written: string[] = [];
  const execCommand = vi.fn(() => true);
  const area = { value: "", style: {}, setAttribute: vi.fn(), select: vi.fn(), remove: vi.fn() };
  vi.stubGlobal("window", { isSecureContext: secure });
  vi.stubGlobal("navigator", {
    clipboard: clipboard ? { writeText: async (text: string) => written.push(text) } : undefined,
  });
  vi.stubGlobal("document", {
    createElement: () => area,
    body: { appendChild: vi.fn() },
    execCommand,
  });
  return { written, execCommand, area };
}

describe("copyText", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the Clipboard API where the browser offers it (localhost, HTTPS)", async () => {
    const fake = page({ secure: true, clipboard: true });
    expect(await copyText("HPC-TZXF-HXNR-5174")).toBe(true);
    expect(fake.written).toEqual(["HPC-TZXF-HXNR-5174"]);
    expect(fake.execCommand).not.toHaveBeenCalled();
  });

  it("★ still copies over plain HTTP on the LAN — the real deployment", async () => {
    const fake = page({ secure: false, clipboard: false });
    expect(await copyText("HPC-TZXF-HXNR-5174")).toBe(true);
    expect(fake.area.value).toBe("HPC-TZXF-HXNR-5174");
    expect(fake.execCommand).toHaveBeenCalledWith("copy");
    expect(fake.area.remove).toHaveBeenCalled();
  });

  it("says so when nothing could copy, so the button does not claim it did", async () => {
    const fake = page({ secure: false, clipboard: false });
    fake.execCommand.mockReturnValue(false);
    expect(await copyText("x")).toBe(false);
  });
});
