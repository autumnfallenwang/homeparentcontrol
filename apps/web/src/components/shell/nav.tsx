"use client";

import { BarChart3, Home, Laptop, LogOut, MoonStar, Settings } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type ComponentType, useState } from "react";
import { signOut } from "../../lib/auth-client.js";

/**
 * The app's navigation, in homework's shape: a sidebar on a desktop — the
 * main sections at the top, Settings pinned to the bottom — and, below the
 * `md` breakpoint, a compact bar across the top instead.
 *
 * ⚠️ The small-screen bar is not optional polish. The grant buttons are used
 * from a phone (P2.6), and a 13rem sidebar on a 375px screen would leave the
 * page 160px wide.
 */

interface NavItem {
  href: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  /** Other routes that belong to this section, e.g. `/setup` is under Macs. */
  also?: readonly string[];
}

const PRIMARY: readonly NavItem[] = [
  { href: "/", label: "Today", icon: Home, also: ["/override"] },
  { href: "/rules", label: "Rules", icon: MoonStar },
  { href: "/devices", label: "Macs", icon: Laptop, also: ["/setup"] },
  { href: "/reports", label: "Activity", icon: BarChart3 },
];

const UTILITY: readonly NavItem[] = [{ href: "/settings", label: "Settings", icon: Settings }];

export const APP_NAME = "Parent Control";

export function isActive(pathname: string | null, item: NavItem): boolean {
  if (!pathname) return false;
  const matches = (href: string) =>
    href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
  return matches(item.href) || (item.also ?? []).some(matches);
}

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={`flex min-h-11 items-center gap-2.5 rounded-md px-3 text-sm transition-colors ${
        active
          ? "bg-secondary font-medium text-foreground"
          : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
      }`}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span>{item.label}</span>
    </Link>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2">
      <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/10">
        <MoonStar className="h-4 w-4 text-primary" />
      </div>
      <span className="font-heading text-[15px] font-semibold tracking-tight">{APP_NAME}</span>
    </div>
  );
}

/**
 * ⚠️ Leaves the page only once the server has ended the session. Going to
 * /sign-in regardless looked like it worked, then bounced straight back to
 * Today with the parent still signed in.
 */
function useSignOut() {
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  const onSignOut = async () => {
    try {
      await signOut();
      router.push("/sign-in");
    } catch {
      setFailed(true);
    }
  };
  return { onSignOut, label: failed ? "Sign-out failed — retry" : "Sign out" };
}

export function Sidebar() {
  const pathname = usePathname();
  const { onSignOut, label } = useSignOut();
  return (
    <aside className="sticky top-0 hidden h-dvh w-52 shrink-0 flex-col border-r border-border bg-sidebar md:flex">
      <div className="px-4 py-4">
        <Brand />
      </div>
      <nav aria-label="Main" className="flex flex-col gap-0.5 px-2">
        {PRIMARY.map((item) => (
          <NavLink key={item.href} item={item} active={isActive(pathname, item)} />
        ))}
      </nav>
      <nav aria-label="Account" className="mt-auto flex flex-col gap-0.5 px-2 pb-3">
        {UTILITY.map((item) => (
          <NavLink key={item.href} item={item} active={isActive(pathname, item)} />
        ))}
        <button
          type="button"
          onClick={onSignOut}
          className="flex min-h-11 items-center gap-2.5 rounded-md px-3 text-sm text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
        >
          <LogOut className="h-4 w-4 shrink-0" />
          <span>{label}</span>
        </button>
      </nav>
    </aside>
  );
}

/**
 * Below `md`: the brand and Sign out, then every section as equal columns.
 *
 * ⚠️ Columns, not a scrolling row. At 390px a row of five labelled tabs
 * overflowed — Settings sat half off-screen behind a scrollbar, which on a
 * phone reads as "there are four sections".
 */
export function MobileNav() {
  const pathname = usePathname();
  const { onSignOut, label } = useSignOut();
  return (
    <div className="border-b border-border bg-sidebar md:hidden">
      <div className="flex items-center justify-between px-4 pt-2">
        <Brand />
        <button
          type="button"
          onClick={onSignOut}
          className="flex min-h-11 items-center gap-1.5 px-1 text-[13px] text-muted-foreground hover:text-foreground"
        >
          <LogOut className="h-4 w-4" />
          {label}
        </button>
      </div>
      <nav aria-label="Main" className="grid grid-cols-5 gap-1 px-2 pb-2">
        {[...PRIMARY, ...UTILITY].map((item) => {
          const active = isActive(pathname, item);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-md text-[11px] ${
                active ? "bg-card font-medium text-foreground shadow-sm" : "text-muted-foreground"
              }`}
            >
              <Icon className="h-5 w-5" />
              {item.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
