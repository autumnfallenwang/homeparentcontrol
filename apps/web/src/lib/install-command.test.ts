import { describe, expect, it } from "vitest";
import { installCommand } from "./install-command.js";

const origin = "http://homeparentcontrol-api.arch.internal";

describe("installCommand", () => {
  it("★ the safe build says so — it is the flag that keeps the power-off a log line", () => {
    expect(installCommand({ apiOrigin: origin, code: "HPC-ABCD-EFGH-JKLM", safe: true })).toBe(
      "sudo agent/scripts/install.sh --safe --base-url http://homeparentcontrol-api.arch.internal/api/agent/v1/ --code HPC-ABCD-EFGH-JKLM",
    );
  });

  it("the full build carries no --safe", () => {
    const command = installCommand({ apiOrigin: origin, code: "HPC-ABCD-EFGH-JKLM", safe: false });
    expect(command).not.toContain("--safe");
    expect(command).toContain("--code HPC-ABCD-EFGH-JKLM");
  });

  it("points the agent at the agent API, with no doubled slash", () => {
    const command = installCommand({ apiOrigin: `${origin}/`, code: "HPC-X", safe: true });
    expect(command).toContain(`--base-url ${origin}/api/agent/v1/ `);
  });
});
