import { Space_Grotesk, Fraunces } from "next/font/google";

/** Chrome / UI typeface. */
export const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space-grotesk",
  display: "swap",
});

/** The user's own words — set in italic per the north-star. */
export const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-fraunces",
  style: ["normal", "italic"],
  display: "swap",
});
