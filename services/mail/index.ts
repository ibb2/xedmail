import { Elysia } from "elysia";
import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import { eq, and } from "drizzle-orm"; // used in auth + route handlers
import { sessionTable, mailboxes, userState, senderRules } from "./schema";

if (!process.env.TURSO_DATABASE_URL) {
  console.error("[mail-service] TURSO_DATABASE_URL is required");
  process.exit(1);
}

// --- DB client ---
function getDb() {
  const client = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
  return drizzle(client, { schema: { sessionTable, mailboxes, userState, senderRules } });
}

const db = getDb();

const PORT = Number(process.env.PORT ?? 3001);

// --- Auth ---
async function validateSession(token: string | undefined): Promise<{ userId: string } | null> {
  if (!token) return null;
  const rows = await db.select({
    userId: sessionTable.userId,
    expiresAt: sessionTable.expiresAt,
  })
    .from(sessionTable)
    .where(eq(sessionTable.token, token))
    .limit(1);
  const row = rows[0];
  if (!row || row.expiresAt < new Date()) return null;
  return { userId: row.userId };
}

function getToken(req: Request): string | undefined {
  const url = new URL(req.url);
  return (
    url.searchParams.get("token") ??
    req.headers.get("authorization")?.replace(/^Bearer /, "") ??
    undefined
  );
}

const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "http://localhost:3000";
const SERVICE_SECRET = process.env.ELYSIA_SERVICE_SECRET ?? "";

const app = new Elysia()
  .onBeforeHandle(({ set }) => {
    set.headers["Access-Control-Allow-Origin"] = CORS_ORIGIN;
    set.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
    set.headers["Access-Control-Allow-Methods"] = "GET, OPTIONS";
  })
  .options("/*", () => new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": CORS_ORIGIN,
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    },
  }))
  .get("/health", () => ({ ok: true }))
  .listen(PORT);

console.log(`Mail service running on port ${PORT}`);

export type App = typeof app;
