import { NextResponse } from "next/server";

export const runtime = "nodejs";

function redirectToCanonical(request: Request, status: 303 | 307) {
  const url = new URL(request.url);
  const target = new URL("/api/mail/oauth/callback", url.origin);
  target.search = url.search;

  return NextResponse.redirect(target, { status });
}

export async function GET(request: Request) {
  return redirectToCanonical(request, 307);
}

export async function POST(request: Request) {
  return redirectToCanonical(request, 303);
}
