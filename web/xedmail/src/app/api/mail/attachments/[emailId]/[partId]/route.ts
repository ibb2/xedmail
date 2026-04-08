export const runtime = "nodejs";
import { requireUserId } from "@/lib/api-auth";
import { NextResponse } from "next/server";

if (!process.env.ELYSIA_SERVICE_URL) {
  throw new Error("ELYSIA_SERVICE_URL is not set");
}

const ELYSIA_URL = process.env.ELYSIA_SERVICE_URL!;
const SERVICE_SECRET = process.env.ELYSIA_SERVICE_SECRET!;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ emailId: string; partId: string }> }
) {
  try {
    await requireUserId();
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }

  const { emailId, partId } = await params;
  try {
    const res = await fetch(`${ELYSIA_URL}/attachments/${emailId}/${partId}`, {
      headers: { "x-service-secret": SERVICE_SECRET },
      cache: "no-store",
    });
    if (!res.ok) return NextResponse.json({ error: "Failed" }, { status: res.status });
    return res;
  } catch {
    return NextResponse.json({ error: "Service unavailable" }, { status: 502 });
  }
}
