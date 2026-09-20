import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "homeparentcontrol",
  description: "Screen-time rules, monitoring and reporting",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
