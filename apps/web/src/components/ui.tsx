"use client";

import { createContext, type ReactNode, useContext, useId } from "react";

/**
 * The small shared pieces.
 *
 * ⚠️ **Everything here has to work at phone width** (P2.6): "there is no
 * mobile app and never will be". The page that settles an argument is opened
 * on a phone, standing up, while someone waits.
 */

export function Card({ children, tone = "plain" }: { children: ReactNode; tone?: Tone }) {
  return (
    <section className={`rounded-xl border p-4 sm:p-5 ${TONE_BORDER[tone]}`}>{children}</section>
  );
}

export type Tone = "plain" | "ok" | "info" | "warn" | "alarm";

const TONE_BORDER: Record<Tone, string> = {
  plain: "border-slate-200 bg-white",
  ok: "border-emerald-200 bg-emerald-50",
  info: "border-sky-200 bg-sky-50",
  warn: "border-amber-300 bg-amber-50",
  alarm: "border-red-300 bg-red-50",
};

const TONE_TEXT: Record<Tone, string> = {
  plain: "text-slate-700",
  ok: "text-emerald-800",
  info: "text-sky-800",
  warn: "text-amber-900",
  alarm: "text-red-900",
};

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
    <div className={`rounded-lg border px-3 py-2 text-sm ${TONE_BORDER[tone]} ${TONE_TEXT[tone]}`}>
      <p className="font-medium">{title}</p>
      {children ? <div className="mt-1 opacity-90">{children}</div> : null}
    </div>
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
    default: "border-slate-300 bg-white hover:bg-slate-50 text-slate-800",
    primary: "border-slate-900 bg-slate-900 text-white hover:bg-slate-800",
    danger: "border-red-300 bg-white text-red-700 hover:bg-red-50",
    quiet: "border-transparent bg-transparent text-slate-500 hover:text-slate-800",
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      // ⚠️ 44px minimum touch target. This is the button someone jabs at on a
      // phone while a child argues; a 28px target is a mis-tap.
      className={`min-h-11 rounded-lg border px-4 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${styles[variant]}`}
    >
      {children}
    </button>
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
      <label htmlFor={id} className="mb-1 block font-medium text-slate-700">
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
  "min-h-11 w-full rounded-lg border border-slate-300 px-3 text-sm focus:border-slate-900 focus:outline-none";

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return <p className="py-8 text-center text-sm text-slate-500">{label}</p>;
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
  return <span className="text-slate-400 italic">{children}</span>;
}
