"use client";

import { createContext, type ReactNode, useContext, useId } from "react";

/**
 * The small shared pieces, in the house look (tokens in `globals.css`).
 *
 * ⚠️ **Everything here has to work at phone width** (P2.6): "there is no
 * mobile app and never will be". The page that settles an argument is opened
 * on a phone, standing up, while someone waits.
 */

export type Tone = "plain" | "ok" | "info" | "warn" | "alarm";

const TONE_SURFACE: Record<Tone, string> = {
  plain: "border-border bg-card",
  ok: "border-ok/30 bg-ok/[0.07]",
  info: "border-info/25 bg-info/[0.06]",
  warn: "border-attention/45 bg-attention/[0.1]",
  alarm: "border-destructive/40 bg-destructive/[0.07]",
};

/** The accent bar on a banner — colour carries the tone, text stays legible. */
const TONE_ACCENT: Record<Tone, string> = {
  plain: "border-l-border",
  ok: "border-l-ok",
  info: "border-l-info",
  warn: "border-l-attention",
  alarm: "border-l-destructive",
};

export function Card({ children, tone = "plain" }: { children: ReactNode; tone?: Tone }) {
  return (
    <section
      className={`rounded-xl border p-4 shadow-[0_2px_8px_rgba(0,0,0,0.04)] sm:p-5 ${TONE_SURFACE[tone]}`}
    >
      {children}
    </section>
  );
}

export function Banner({
  tone,
  title,
  children,
}: {
  tone: Tone;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={`rounded-lg border border-l-4 px-3 py-2 text-sm text-foreground ${TONE_SURFACE[tone]} ${TONE_ACCENT[tone]}`}
    >
      <p className="font-medium">{title}</p>
      {children ? <div className="mt-1 text-foreground/80">{children}</div> : null}
    </div>
  );
}

const BADGE: Record<Tone, string> = {
  plain: "bg-secondary text-secondary-foreground",
  ok: "bg-ok/15 text-[oklch(0.42_0.11_145)]",
  info: "bg-info/12 text-info",
  warn: "bg-attention/20 text-attention-foreground",
  alarm: "bg-destructive/12 text-destructive",
};

/** A short status pill: "checking in", "needs you", "0.1.0-dev". */
export function Badge({ tone = "plain", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${BADGE[tone]}`}
    >
      {children}
    </span>
  );
}

export function Button({
  children,
  onClick,
  disabled,
  variant = "default",
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "default" | "primary" | "danger" | "quiet";
  type?: "button" | "submit";
}) {
  const styles: Record<string, string> = {
    default: "border-border bg-card text-foreground hover:bg-secondary",
    primary: "border-primary bg-primary text-primary-foreground hover:bg-primary/90",
    danger: "border-destructive/40 bg-card text-destructive hover:bg-destructive/[0.07]",
    quiet:
      "border-transparent bg-transparent text-muted-foreground underline decoration-muted-foreground/40 underline-offset-4 hover:text-foreground",
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      // ⚠️ 44px minimum touch target. This is the button someone jabs at on a
      // phone while a child argues; a 28px target is a mis-tap.
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border px-4 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${styles[variant]}`}
    >
      {children}
    </button>
  );
}

/**
 * A choice between a few options, all visible at once.
 *
 * ⚠️ Why not a `<select>`: on the first real runs the bedtime window's action
 * — "Lock the screen" or "Lock, then shut down" — was a dropdown, and it was
 * left on its default twice, costing two test runs. A choice this
 * consequential should be on screen, not behind a click.
 */
export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (next: T) => void;
}) {
  // Real radio inputs: arrow keys, VoiceOver's "1 of 2", and a form value,
  // all for free. The label is the 44px target.
  const name = useId();
  return (
    // ⚠️ The legend IS the visible label — a separate caption above it made
    // VoiceOver read the question twice.
    <fieldset>
      <legend className="mb-1 text-[13px] font-medium text-foreground/80">{label}</legend>
      <div className="flex w-full flex-wrap gap-1 rounded-lg border border-border bg-secondary p-1">
        {options.map((option) => {
          const on = option.value === value;
          return (
            <label
              key={option.value}
              className={`flex min-h-11 flex-1 cursor-pointer items-center justify-center rounded-md px-3 text-center text-sm font-medium transition has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/40 ${
                on
                  ? "bg-card text-foreground shadow-sm ring-1 ring-border"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={on}
                onChange={() => onChange(option.value)}
                className="sr-only"
              />
              {option.label}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/**
 * ⚠️ Renders a real `<label for>` rather than wrapping the control.
 *
 * Nesting works in browsers and is invisible to a screen reader when the
 * control is passed as `children` — the association has to be explicit for
 * VoiceOver to announce it, and VoiceOver is how this page gets used
 * one-handed on a phone.
 */
export function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  // ⚠️ `useId()` unconditionally, then choose. `htmlFor ?? useId()` calls
  // the hook conditionally, which changes hook order between renders.
  const generated = useId();
  const id = htmlFor ?? generated;
  return (
    <div className="block text-sm">
      <label htmlFor={id} className="mb-1 block text-[13px] font-medium text-foreground/80">
        {label}
      </label>
      <FieldIdContext.Provider value={id}>{children}</FieldIdContext.Provider>
    </div>
  );
}

const FieldIdContext = createContext<string | undefined>(undefined);

/** The id `Field` generated, for the control inside it. */
export function useFieldId(): string | undefined {
  return useContext(FieldIdContext);
}

export const inputClass =
  "min-h-11 w-full rounded-lg border border-border bg-card px-3 text-sm text-foreground focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/20";

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return <p className="py-8 text-center text-sm text-muted-foreground">{label}</p>;
}

export function ErrorNote({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <Banner tone="alarm" title="Something went wrong">
      {message}
    </Banner>
  );
}

/**
 * ★ §5.7: zero and unknown are different facts.
 *
 * Used wherever a number could be either. A dash with an explanation beats a
 * zero that quietly asserts the Mac was on and unused.
 */
export function NoData({ children }: { children: ReactNode }) {
  return <span className="italic text-muted-foreground/80">{children}</span>;
}
