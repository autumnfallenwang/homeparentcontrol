"use client";

import {
  ArrowLeft,
  BarChart3,
  CircleAlert,
  Home,
  LogOut,
  MoonStar,
  Palette,
  Settings,
  Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type ComponentType, useState } from "react";
import { signOut } from "../../lib/auth-client.js";
import { useViewing } from "./viewing.js";

/**
 * The app's navigation, in homework's shape.
 *
 * - **Main sidebar:** Today, Rules and Activity — each about ONE child — then
 *   the **Viewing** switch that picks the child, then Settings pinned to the
 *   bottom.
 * - **Settings sidebar:** replaces the main one under `/settings` — Back,
 *   then one row per tab. Settings holds only what belongs to the whole
 *   household: who the children and devices are, and how the app looks.
 *
 * ⚠️ Below `md` there is a minimal top bar instead. Phone layout is out of
 * scope for this round; the bar exists so a phone is not left with no way
 * to move between pages at all.
 */

interface NavItem {
  href: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  /** Other routes that belong to this section — a Mac's own page is Today's. */
  also?: readonly string[];
}

const PRIMARY: readonly NavItem[] = [
  { href: "/", label: "Today", icon: Home, also: ["/override", "/devices"] },
  { href: "/rules", label: "Rules", icon: MoonStar },
  { href: "/reports", label: "Activity", icon: BarChart3 },
];

const SETTINGS_ITEM: NavItem = { href: "/settings", label: "Settings", icon: Settings };

export const SETTINGS_TABS = [
  { key: "children", label: "Children & devices", icon: Users },
  { key: "appearance", label: "Appearance", icon: Palette },
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number]["key"];

export function isSettingsTab(value: unknown): value is SettingsTab {
  return SETTINGS_TABS.some((tab) => tab.key === value);
}

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

function SignOutButton() {
  const { onSignOut, label } = useSignOut();
  return (
    <button
      type="button"
      onClick={onSignOut}
      className="flex min-h-11 items-center gap-2.5 rounded-md px-3 text-sm text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
    >
      <LogOut className="h-4 w-4 shrink-0" />
      <span>{label}</span>
    </button>
  );
}

/** homework's "Viewing" list: one row per child, the current one marked. */
function ViewingList() {
  const { children, child, select, needsYou } = useViewing();
  if (!children || children.length === 0) return null;
  return (
    <div className="mx-2 mt-3 border-t border-border/70 pt-3">
      <p className="px-3 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        Viewing
      </p>
      <ul className="space-y-0.5">
        {children.map((item) => {
          const on = item.id === child?.id;
          const alarm = needsYou.has(item.id);
          return (
            <li key={item.id}>
              <button
                type="button"
                aria-pressed={on}
                onClick={() => select(item.id)}
                className={`flex min-h-11 w-full items-center gap-2 rounded-md px-3 text-left text-sm transition-colors ${
                  on
                    ? "bg-secondary font-medium text-foreground"
                    : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${on ? "bg-primary" : "bg-transparent"}`}
                />
                <span className="min-w-0 flex-1 truncate">{item.displayName}</span>
                {/* ★ Another child's alarm stays visible from this child's
                    pages — scoping must not hide a silent Mac. */}
                {alarm ? (
                  <span title={`${item.displayName}: a device needs you`}>
                    <CircleAlert aria-hidden="true" className="h-4 w-4 shrink-0 text-attention" />
                    <span className="sr-only">needs you</span>
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="sticky top-0 hidden h-viewport w-52 shrink-0 flex-col border-r border-border bg-sidebar md:flex">
      <div className="px-4 py-4">
        <Brand />
      </div>
      <nav aria-label="Main" className="flex flex-col gap-0.5 px-2">
        {PRIMARY.map((item) => (
          <NavLink key={item.href} item={item} active={isActive(pathname, item)} />
        ))}
      </nav>
      <ViewingList />
      <nav aria-label="Account" className="mt-auto flex flex-col gap-0.5 px-2 pb-3">
        <NavLink item={SETTINGS_ITEM} active={isActive(pathname, SETTINGS_ITEM)} />
        <SignOutButton />
      </nav>
    </aside>
  );
}

/** Under `/settings`: Back, then the tabs — homework's settings sidebar. */
export function SettingsSidebar() {
  const pathname = usePathname();
  return (
    <aside className="sticky top-0 hidden h-viewport w-52 shrink-0 flex-col border-r border-border bg-sidebar md:flex">
      <div className="px-4 py-4">
        <span className="font-heading text-[15px] font-semibold tracking-tight">Settings</span>
      </div>
      <nav aria-label="Settings" className="flex flex-col gap-0.5 px-2">
        {/* Always home, never history: each tab click is a history entry, so
            "back" would rewind tab by tab instead of leaving Settings. */}
        <Link
          href="/"
          className="flex min-h-11 items-center gap-2.5 rounded-md px-3 text-sm text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4 shrink-0" />
          <span>Back</span>
        </Link>
        {SETTINGS_TABS.map((tab) => (
          <NavLink
            key={tab.key}
            item={{ href: `/settings/${tab.key}`, label: tab.label, icon: tab.icon }}
            active={pathname === `/settings/${tab.key}`}
          />
        ))}
      </nav>
      <nav aria-label="Account" className="mt-auto flex flex-col gap-0.5 px-2 pb-3">
        <SignOutButton />
      </nav>
    </aside>
  );
}

/** Below `md`. Minimal by decision — see the note at the top of this file. */
export function MobileNav() {
  const pathname = usePathname();
  const { children, child, select, needsYou } = useViewing();
  return (
    <div className="border-b border-border bg-sidebar md:hidden">
      <div className="flex items-center justify-between gap-2 px-4 pt-2">
        <Brand />
        <SignOutButton />
      </div>
      {children && children.length > 1 ? (
        <div className="px-4 pt-1">
          <select
            aria-label="Viewing"
            className="min-h-11 w-full rounded-lg border border-border bg-card px-3 text-sm"
            value={child?.id ?? ""}
            onChange={(event) => select(event.target.value)}
          >
            {children.map((item) => (
              <option key={item.id} value={item.id}>
                {item.displayName}
                {needsYou.has(item.id) ? " — needs you" : ""}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <nav aria-label="Main" className="grid grid-cols-4 gap-1 px-2 py-2">
        {[...PRIMARY, SETTINGS_ITEM].map((item) => {
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
