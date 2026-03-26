import { Elysia } from "elysia";
import { ImapFlow } from "imapflow";
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

// --- IMAP types ---
type EmailMetadata = {
  id: string;
  mailboxId: string;
  uid: number;
  threadId: string;
  subject: string;
  fromName: string;
  fromAddress: string;
  date: number;
  snippet: string;
  isRead: boolean;
  isStarred: boolean;
  labels: string[];
  hasAttachments: boolean;
};

type ImapConnection = {
  client: ImapFlow;
  seqToUid: number[];
  watermarkUid: number;
  mailboxAddress: string;
  userId: string;
  wsClients: Set<{ send: (data: string) => void }>;
};

const connections = new Map<string, ImapConnection>(); // key: `${userId}:${mailboxAddress}`

// --- IMAP helpers ---
function extractSnippet(text: string, maxLen = 200): string {
  return text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLen);
}

function hasAttachmentParts(structure: any): boolean {
  if (!structure) return false;
  if (structure.disposition?.type?.toLowerCase() === "attachment") return true;
  if (Array.isArray(structure.childNodes)) {
    return structure.childNodes.some(hasAttachmentParts);
  }
  return false;
}

function messageToMetadata(msg: any, mailboxAddress: string): EmailMetadata {
  const env = msg.envelope ?? {};
  const from = env.from?.[0] ?? {};
  return {
    id: `${mailboxAddress}:${msg.uid}`,
    mailboxId: mailboxAddress,
    uid: msg.uid,
    threadId: String(msg.gmailThreadId ?? ""),
    subject: env.subject ?? "(No Subject)",
    fromName: from.name ?? "Unknown",
    fromAddress: from.address ?? "unknown",
    date: msg.internalDate ? new Date(msg.internalDate).getTime() : Date.now(),
    snippet: extractSnippet(typeof msg.bodyPart === "string"
      ? msg.bodyPart
      : msg.bodyPart?.toString() ?? ""),
    isRead: msg.flags?.has("\\Seen") ?? false,
    isStarred: msg.flags?.has("\\Flagged") ?? false,
    labels: Array.isArray(msg.gmailLabels) ? [...msg.gmailLabels] : [],
    hasAttachments: hasAttachmentParts(msg.bodyStructure),
  };
}

async function fetchUidRange(
  client: ImapFlow,
  mailboxAddress: string,
  uidSet: string, // e.g. "1:500" or "1234:*"
): Promise<EmailMetadata[]> {
  const results: EmailMetadata[] = [];
  for await (const msg of client.fetch(uidSet, {
    uid: true,
    envelope: true,
    flags: true,
    bodyStructure: true,
    internalDate: true,
    bodyPart: "TEXT",
    // Gmail extensions — silently ignored for non-Gmail
    // @ts-ignore
    "X-GM-THRID": true,
    // @ts-ignore
    "X-GM-LABELS": true,
  }, { uid: true })) {
    results.push(messageToMetadata(msg, mailboxAddress));
  }
  return results;
}

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
