export interface Message {
  id: string;
  role: "you" | "director";
  text: string;
  /** Optional tag for styling (e.g. an edit summary vs. plain chat). */
  tone?: "info" | "edit" | "error";
  /** Tool names a Director edit called (drives the next-step chips). */
  tools?: string[];
  /** The request this reply answers (for "did you mean" / "try again"). */
  request?: string;
  /** A reply the rail can help recover from: no tool matched, or the call failed. */
  kind?: "unmatched" | "failed";
}
