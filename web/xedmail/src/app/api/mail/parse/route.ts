import { NextResponse } from "next/server";

export const runtime = "nodejs";

const MS_PARSER_URL =
  process.env.MS_PARSER_URL ?? "http://127.0.0.1:8000/parse";

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams.get("q") ?? "";
  if (!q.trim()) {
    return NextResponse.json({ intent: null, filters: {} });
  }

  try {
    const res = await fetch(MS_PARSER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: q }),
      signal: AbortSignal.timeout(3000),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`parser ${res.status}`);
    return NextResponse.json(await res.json());
  } catch {
    // FastAPI unavailable — caller falls back to regex
    return NextResponse.json({ intent: null, filters: {} });
  }
}
