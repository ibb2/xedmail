// web/xedmail/src/app/api/auth/[...all]/route.ts
export const runtime = "nodejs";

import { auth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";

const handler = toNextJsHandler(auth);

export async function GET(req: Request) {
  const res = await handler.GET(req);
  if (res.status >= 500) {
    const body = await res.clone().text();
    console.error("[auth] GET error", res.status, new URL(req.url).pathname, body);
  }
  return res;
}

export const { POST } = handler;
