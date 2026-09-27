/**
 * A health state in a few words, for badges and the device timeline.
 *
 * ⚠️ Not a sentence about the Mac. Sentences come from `healthPhrasing`
 * (via `cardPhrasing`); this is only the short label beside them, so a parent
 * never reads `SILENT_TOO_LONG` on one page and "not checking in" on another.
 */
export function stateLabel(state: string): string {
  switch (state) {
    case "HEALTHY":
      return "checking in";
    case "DEGRADED":
      return "needs attention";
    case "EXPECTED_OFFLINE":
      return "asleep";
    case "UNEXPECTED_SILENCE":
    case "SILENT_TOO_LONG":
      return "not checking in";
    default:
      return state.toLowerCase().replaceAll("_", " ");
  }
}
