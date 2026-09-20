import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "homeparentcontrol",
  description: "Screen-time rules, monitoring and reporting",
};

/**
 * ⚠️ **P2.6 — "there is no mobile app and never will be."** Every parent
 * surface is this app in a browser on the LAN, and the page that settles an
 * argument gets opened on a phone while someone waits. Without this viewport
 * tag iOS renders at 980px and scales down, which makes the grant buttons
 * roughly 15px tall.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh bg-slate-50 text-slate-900 antialiased">{children}</body>
    </html>
  );
}
