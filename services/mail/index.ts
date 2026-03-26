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

const app = new Elysia()
  .get("/health", () => ({ ok: true }))
  .listen(PORT);

console.log(`Mail service running on port ${PORT}`);

export type App = typeof app;
