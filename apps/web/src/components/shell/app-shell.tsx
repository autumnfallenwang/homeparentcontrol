"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { ThemeProvider } from "../theme-provider.js";
import { MobileNav, SettingsSidebar, Sidebar } from "./nav.js";
import { ViewingProvider } from "./viewing.js";

/**
 * The signed-in frame: the Viewing state, the theme, and the sidebar —
 * Settings gets its own, as in homework, so its tabs never sit beside the
 * child switch they have nothing to do with.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "";
  const inSettings = pathname === "/settings" || pathname.startsWith("/settings/");
  return (
    <ViewingProvider>
      <ThemeProvider />
      <div className="flex min-h-viewport">
        {inSettings ? <SettingsSidebar /> : <Sidebar />}
        <div className="flex min-w-0 flex-1 flex-col">
          <MobileNav />
          <main className="flex-1">{children}</main>
        </div>
      </div>
    </ViewingProvider>
  );
}
