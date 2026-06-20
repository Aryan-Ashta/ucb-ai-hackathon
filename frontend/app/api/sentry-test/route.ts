import { NextResponse } from "next/server";

// Hit GET /api/sentry-test to fire a test error to Sentry.
// Delete this route after confirming errors appear in the Sentry dashboard.
export function GET() {
  throw new Error("Sentry test error — VibeSchool server route");
  return NextResponse.json({ ok: true });
}
