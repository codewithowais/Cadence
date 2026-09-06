import { Space_Grotesk, Fraunces } from "next/font/google";

// Both fonts are consumed via CSS variables (a two-font system), not applied
// through next/font's own className. next/font still emits <link rel="preload">
// for each, which the browser then reports as "preloaded but not used" because
// it can't tie the preload to the CSS-var usage. We load them with display:swap
// and preload:false to drop those spurious links; they still fetch promptly.

/** Chrome / UI typeface. */
export const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space-grotesk",
  display: "swap",
  preload: false,
});

/** The user's own words — set in italic per the north-star. */
export const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-fraunces",
  style: ["normal", "italic"],
  display: "swap",
  preload: false,
});
