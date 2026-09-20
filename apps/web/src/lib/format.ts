/**
 * Formatting that carries meaning.
 *
 * ⚠️ Two of these exist because §5.7's first honesty rule is easy to break by
 * accident: "**zero usage and no data look identical on a bar chart and mean
 * opposite things**". A `0` rendered for an hour nobody reported is a claim
 * the Mac was on and unused, which is a different fact from "we do not know".
 */

/** "2 days", "14 minutes", "just now". */
export function humanDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "unknown";
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

/** "1 h 24 m" — for an amount of use, where precision reads as false accuracy. */
export function humanMinutes(seconds: number): string {
  const total = Math.round(seconds / 60);
  if (total === 0) return "0 m";
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours === 0) return `${minutes} m`;
  if (minutes === 0) return `${hours} h`;
  return `${hours} h ${minutes} m`;
}

/** The weekday a policy was published on — what §4.6's sentence names. */
export function weekdayOf(iso: string | null | undefined): string | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  if (sameDay) return "today";
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (date.toDateString() === yesterday.toDateString()) return "yesterday";
  return date.toLocaleDateString(undefined, { weekday: "long" });
}

export function clockTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function dayAndTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** `com.apple.Safari` → `Safari`. Falls back to the whole id. */
export function appName(bundleId: string): string {
  if (bundleId === "other") return "Everything else";
  const tail = bundleId.split(".").pop();
  return tail && tail.length > 1 ? tail : bundleId;
}

export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export const DAY_LABEL: Record<string, string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};
