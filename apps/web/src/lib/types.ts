export interface Message {
  id: string;
  role: "you" | "director";
  text: string;
  /** Optional tag for styling (e.g. an edit summary vs. plain chat). */
  tone?: "info" | "edit" | "error";
}
