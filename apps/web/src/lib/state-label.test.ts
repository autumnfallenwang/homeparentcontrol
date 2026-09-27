import { describe, expect, it } from "vitest";
import { stateLabel } from "./state-label.js";

describe("stateLabel", () => {
  it("never shows a raw enum for the states a parent sees most", () => {
    expect(stateLabel("HEALTHY")).toBe("checking in");
    expect(stateLabel("SILENT_TOO_LONG")).toBe("not checking in");
    expect(stateLabel("EXPECTED_OFFLINE")).toBe("asleep");
  });

  it("falls back to lower-case words for a state it does not know", () => {
    expect(stateLabel("SOME_NEW_STATE")).toBe("some new state");
  });
});
