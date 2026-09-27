import Link from "next/link";
import type { ReactNode } from "react";

/**
 * One page inside the app shell: a sticky header — title on the left,
 * actions on the right, as in homework's `PageHeader` — then the content in
 * a single readable column.
 *
 * `back` is for pages one level down (a Mac's own page, "Add a Mac").
 */
export function Page({
  title,
  subtitle,
  actions,
  back,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  back?: { href: string; label: string };
  children: ReactNode;
}) {
  return (
    <>
      <header className="sticky top-0 z-20 border-b border-border bg-card/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3.5 sm:px-6">
          <div className="min-w-0">
            {back ? (
              <Link
                href={back.href}
                className="text-[13px] text-muted-foreground hover:text-foreground"
              >
                ← {back.label}
              </Link>
            ) : null}
            <h1 className="font-heading text-2xl font-medium tracking-tight">{title}</h1>
            {subtitle ? (
              <div className="mt-0.5 text-sm text-muted-foreground">{subtitle}</div>
            ) : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      </header>
      <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-6 sm:px-6">{children}</div>
    </>
  );
}

/** A heading inside a card, in the serif — homework's section style. */
export function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="font-heading text-lg font-medium tracking-tight">{children}</h2>;
}
