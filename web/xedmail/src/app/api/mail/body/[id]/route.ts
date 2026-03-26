export const runtime = "nodejs";
import { requireUserId } from "@/lib/api-auth";
import { NextResponse } from "next/server";

const ELYSIA_URL = process.env.ELYSIA_SERVICE_URL!;
const SERVICE_SECRET = process.env.ELYSIA_SERVICE_SECRET!;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireUserId();
  const { id } = await params;
  const res = await fetch(`${ELYSIA_URL}/body/${id}`, {
    headers: { "x-service-secret": SERVICE_SECRET },
    cache: "no-store",
  });
  if (!res.ok) return NextResponse.json({ error: "Failed" }, { status: res.status });
  return res;
}
