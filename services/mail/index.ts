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

// --- IMAP IDLE daemon ---
async function startIdleConnection(
  userId: string,
  mailboxAddress: string,
  accessToken: string,
): Promise<ImapConnection> {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST ?? "imap.gmail.com",
    port: Number(process.env.IMAP_PORT ?? 993),
    secure: process.env.IMAP_SECURE !== "false",
    auth: { user: mailboxAddress, accessToken },
    logger: false,
  });

  const wsClients: Set<{ send: (data: string) => void }> = new Set();
  const conn: ImapConnection = { client, seqToUid: [], watermarkUid: 0, mailboxAddress, userId, wsClients };

  const broadcast = (obj: object) => {
    const msg = JSON.stringify(obj);
    for (const c of wsClients) c.send(msg);
  };

  const reconnect = async (delayMs = 1000) => {
    broadcast({ type: "reconnecting", mailboxId: mailboxAddress });
    await new Promise(r => setTimeout(r, Math.min(delayMs, 60_000)));
    try {
      await client.connect();
      await initIdle(conn, broadcast, reconnect);
    } catch {
      void reconnect(delayMs * 2);
    }
  };

  await client.connect();
  await initIdle(conn, broadcast, reconnect);

  return conn;
}

async function initIdle(
  conn: ImapConnection,
  broadcast: (obj: object) => void,
  reconnect: (delay?: number) => void,
) {
  const { client, mailboxAddress } = conn;

  // Remove any listeners from previous IDLE sessions before re-registering
  client.removeAllListeners("error");
  client.removeAllListeners("close");
  client.removeAllListeners("exists");
  client.removeAllListeners("expunge");
  client.removeAllListeners("flags");

  client.on("error", () => reconnect());
  client.on("close", () => reconnect());

  const lock = await client.getMailboxLock("INBOX");
  conn.seqToUid = [];
  for await (const msg of client.fetch("1:*", { uid: true })) {
    conn.seqToUid[msg.seq - 1] = msg.uid;
  }
  conn.watermarkUid = Math.max(0, ...conn.seqToUid.filter(Boolean));
  lock.release();

  client.on("exists", async ({ count }: { count: number }) => {
    if (count <= conn.seqToUid.length) return;
    // Fetch new messages since watermark
    const lock2 = await client.getMailboxLock("INBOX");
    try {
      const emails = await fetchUidRange(client, mailboxAddress, `${conn.watermarkUid + 1}:*`);
      for (const e of emails) {
        conn.seqToUid.push(e.uid);
        if (e.uid > conn.watermarkUid) conn.watermarkUid = e.uid;
      }
      if (emails.length) broadcast({ type: "exists", emails });
    } finally { lock2.release(); }
  });

  client.on("expunge", ({ seq }: { seq: number }) => {
    const uid = conn.seqToUid[seq - 1];
    if (uid) {
      conn.seqToUid.splice(seq - 1, 1);
      broadcast({ type: "expunge", id: `${mailboxAddress}:${uid}` });
    }
  });

  client.on("flags", async ({ uid, flags }: { uid: number; flags: Set<string> }) => {
    broadcast({
      type: "flags",
      id: `${mailboxAddress}:${uid}`,
      isRead: flags.has("\\Seen"),
      isStarred: flags.has("\\Flagged"),
    });
  });

  // Start IDLE
  await client.idle();
  broadcast({ type: "reconnected", mailboxId: mailboxAddress });
}

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
  .get("/stream", async ({ request, set }) => {
    const token = getToken(request);
    const session = await validateSession(token);
    if (!session) return new Response("Unauthorized", { status: 401 });

    const url = new URL(request.url);
    const mailboxAddress = url.searchParams.get("mailbox");
    const cursor = url.searchParams.get("cursor") ? Number(url.searchParams.get("cursor")) : null;
    if (!mailboxAddress) return new Response("Missing mailbox", { status: 400 });

    // Verify user owns mailbox
    const mb = await db.select().from(mailboxes)
      .where(and(eq(mailboxes.userId, session.userId), eq(mailboxes.emailAddress, mailboxAddress)))
      .limit(1);
    if (!mb[0]) return new Response("Forbidden", { status: 403 });

    set.headers["Content-Type"] = "text/event-stream";
    set.headers["Cache-Control"] = "no-cache";
    set.headers["Connection"] = "keep-alive";

    const stream = new ReadableStream({
      async start(controller) {
        const send = (obj: object) => {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(obj)}\n\n`));
        };

        const client = new ImapFlow({
          host: process.env.IMAP_HOST ?? "imap.gmail.com",
          port: Number(process.env.IMAP_PORT ?? 993),
          secure: process.env.IMAP_SECURE !== "false",
          auth: { user: mailboxAddress, accessToken: mb[0].accessToken },
          logger: false,
        });

        try {
          await client.connect();
          const lock = await client.getMailboxLock("INBOX");

          try {
            // Build seqToUid map
            const seqToUid: number[] = [];
            for await (const msg of client.fetch("1:*", { uid: true })) {
              seqToUid[msg.seq - 1] = msg.uid;
            }

            const allUids = seqToUid.filter(Boolean).sort((a, b) => b - a);
            const watermark = allUids[0] ?? 0;

            // Initial eager batch: latest 500
            const initialUids = allUids.slice(0, 500);
            for (let i = 0; i < initialUids.length; i += 50) {
              const batch = initialUids.slice(i, i + 50);
              if (!batch.length) break;
              const uidSet = `${batch[batch.length - 1]}:${batch[0]}`;
              const emails = await fetchUidRange(client, mailboxAddress, uidSet);
              send({ type: "batch", emails });
            }

            // Background backfill: remaining history in batches of 200
            const remaining = cursor
              ? allUids.filter(u => u < cursor)
              : allUids.slice(500);

            for (let i = 0; i < remaining.length; i += 200) {
              const batch = remaining.slice(i, i + 200);
              if (!batch.length) break;
              const uidSet = `${batch[batch.length - 1]}:${batch[0]}`;
              const emails = await fetchUidRange(client, mailboxAddress, uidSet);
              send({ type: "batch", emails, cursor: batch[batch.length - 1] });
              // Yield to event loop between backfill batches
              await new Promise(r => setTimeout(r, 0));
            }

            send({ type: "backfill_complete", mailboxId: mailboxAddress, watermarkUid: watermark });
          } finally {
            lock.release();
          }
        } catch (err) {
          send({ type: "error", message: String(err) });
        } finally {
          client.close();
          controller.close();
        }
      },
    });

    return new Response(stream, { headers: set.headers as HeadersInit });
  })
  .ws("/events", {
    async open(ws) {
      // token passed as query param on upgrade
      const req = (ws as any).data?.request as Request | undefined;
      const token = req ? getToken(req) : undefined;
      const session = await validateSession(token);
      if (!session) { ws.close(4001, "Unauthorized"); return; }

      const url = req ? new URL(req.url) : null;
      const mailboxAddress = url?.searchParams.get("mailbox");
      if (!mailboxAddress) { ws.close(4000, "Missing mailbox"); return; }

      const mb = await db.select().from(mailboxes)
        .where(and(eq(mailboxes.userId, session.userId), eq(mailboxes.emailAddress, mailboxAddress)))
        .limit(1);
      if (!mb[0]) { ws.close(4003, "Forbidden"); return; }

      const connKey = `${session.userId}:${mailboxAddress}`;
      let conn = connections.get(connKey);

      if (!conn) {
        conn = await startIdleConnection(session.userId, mailboxAddress, mb[0].accessToken);
        connections.set(connKey, conn);
      }

      conn.wsClients.add(ws);

      (ws as any)._connKey = connKey;
    },
    close(ws) {
      const connKey = (ws as any)._connKey as string | undefined;
      if (connKey) {
        const conn = connections.get(connKey);
        if (conn) {
          conn.wsClients.delete(ws);
          // Clean up idle connection when no more clients are watching
          if (conn.wsClients.size === 0) {
            conn.client.close();
            connections.delete(connKey);
          }
        }
      }
    },
    message() {},
  })
  .listen(PORT);

console.log(`Mail service running on port ${PORT}`);

export type App = typeof app;
