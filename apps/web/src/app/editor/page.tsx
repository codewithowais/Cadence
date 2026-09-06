import { Editor } from "@/components/Editor";

export const metadata = { title: "Scratch editor — Cadence" };

/** The standalone scratch editor — no auth, no persistence. */
export default function EditorPage() {
  return <Editor />;
}
