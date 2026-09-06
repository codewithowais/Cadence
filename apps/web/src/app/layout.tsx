import type { Metadata, Viewport } from "next";
import { spaceGrotesk, fraunces } from "@/lib/fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cadence — prompt-native video editor",
  description: "Describe the edit. Cadence makes it, and shows you — always editable.",
};

export const viewport: Viewport = {
  themeColor: "#f3f4f4",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${spaceGrotesk.variable} ${fraunces.variable}`}>
      <body>{children}</body>
    </html>
  );
}
