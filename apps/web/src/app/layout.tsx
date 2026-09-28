import type { Metadata, Viewport } from "next";
import { DM_Sans, Newsreader } from "next/font/google";
import { APPEARANCE_BOOT_SCRIPT } from "../lib/theme.js";
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
    // `suppressHydrationWarning`: the boot script adds `dark` and the size
    // before React hydrates, so <html>'s attributes differ from the server's
    // on purpose. It covers this one element, not the tree.
    <html
      lang="en"
      className={`${newsreader.variable} ${dmSans.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* ⚠️ A plain inline script, not next/script: `beforeInteractive`
            inline scripts in the App Router wait for Next's runtime, which
            is after the first paint — a white flash on a dark tablet at
            night. The content is a constant from lib/theme.ts; nothing a
            user typed reaches it. */}
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: constant boot script, no user input */}
        <script dangerouslySetInnerHTML={{ __html: APPEARANCE_BOOT_SCRIPT }} />
      </head>
      <body className="min-h-viewport bg-background text-foreground antialiased">{children}</body>
    </html>
  );
}
