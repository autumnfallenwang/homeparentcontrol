import type { Metadata, Viewport } from "next";
import { DM_Sans, Newsreader } from "next/font/google";
import "./globals.css";

/**
 * Self-hosted at build time. homework loads these from Google with a CSS
 * `@import`, which makes every page view a request to Google from the LAN
 * and leaves the headings in Georgia whenever that request fails.
 */
const newsreader = Newsreader({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-newsreader",
  display: "swap",
});
const dmSans = DM_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-dm-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Parent Control",
  description: "Screen-time rules for the Macs at home",
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
    <html lang="en" className={`${newsreader.variable} ${dmSans.variable}`}>
      <body className="min-h-dvh bg-background text-foreground antialiased">{children}</body>
    </html>
  );
}
