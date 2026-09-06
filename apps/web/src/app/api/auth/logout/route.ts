import { NextResponse, type NextRequest } from "next/server";
import { getAuthProvider } from "@/lib/auth";

export const runtime = "nodejs";

/** Clear the session cookie and return to the landing page. */
export async function POST(req: NextRequest) {
  await getAuthProvider().signOut();
  return NextResponse.redirect(new URL("/", req.url), 303);
}
