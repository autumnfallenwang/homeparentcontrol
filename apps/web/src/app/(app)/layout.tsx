import type { ReactNode } from "react";
import { MobileNav, Sidebar } from "../../components/shell/nav.js";

/**
 * Every signed-in page. A route group, so the URLs are unchanged — `/`,
 * `/rules`, `/devices/…` — and `/sign-in` stays outside the shell.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <MobileNav />
        <main className="flex-1">{children}</main>
      </div>
    </div>
  );
}
