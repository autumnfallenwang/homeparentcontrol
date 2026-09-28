import type { ReactNode } from "react";
import { AppShell } from "../../components/shell/app-shell.js";

/**
 * Every signed-in page. A route group, so the URLs are unchanged — `/`,
 * `/rules`, `/settings/…` — and `/sign-in` stays outside the shell.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
