/**
 * A tiny window event bus for "open the Describe-your-video studio" — so any panel
 * (the Text room, the Director rail, the empty state) can open it without threading a
 * callback through every intermediate component. The Editor is the only listener.
 */
export interface OpenStudioDetail {
  /** Pre-fill the prompt box. */
  prompt?: string;
  /** Open straight on the storyboard review for the video that's already in the project. */
  review?: boolean;
}

const EVENT = "cadence:open-studio";

export function openPromptStudio(detail: OpenStudioDetail = {}): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<OpenStudioDetail>(EVENT, { detail }));
}

/** Subscribe (returns the unsubscribe function). */
export function onOpenPromptStudio(handler: (detail: OpenStudioDetail) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (e: Event) => handler((e as CustomEvent<OpenStudioDetail>).detail ?? {});
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}

/** Example sentences shown as one-tap chips (and used by the landing page). */
export const STUDIO_EXAMPLES: { label: string; prompt: string }[] = [
  { label: "Cafe promo", prompt: "30s Instagram promo for my coffee shop, warm vibe, upbeat music" },
  { label: "Birthday wish", prompt: "birthday wish for Ayesha" },
  { label: "Explainer", prompt: "explain how photosynthesis works in 45s" },
  { label: "Travel recap", prompt: "travel recap of Istanbul using my photos" },
  { label: "Tips", prompt: "5 tips for better sleep" },
  { label: "Event invite", prompt: "invite to my daughter's birthday party this Saturday at 6pm at Gulberg Club" },
  { label: "Product launch", prompt: "product launch for Nimbus, a budgeting app, cinematic" },
  { label: "Eid greeting", prompt: "Eid Mubarak video for my friend Hamza" },
];
