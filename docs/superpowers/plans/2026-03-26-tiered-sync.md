# Tiered Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Jazz-based client state and Next.js IMAP polling with a Dexie (IndexedDB) local cache synced via SSE/WebSocket from a single-file Elysia/Bun IMAP microservice, and eliminate Jazz entirely.

**Architecture:** The Elysia service (`services/mail/index.ts`) owns all IMAP connections, streams metadata to the browser over SSE, and pushes real-time deltas over WebSocket. The Next.js app replaces `jazz-provider.tsx` with a `SyncProvider` that consumes Dexie for local state, opens SSE/WS connections directly to Elysia, and proxies body/attachment fetches through Next.js routes.

**Tech Stack:** Bun, Elysia, ImapFlow, Drizzle ORM + drizzle-kit, @libsql/client (Turso), Dexie 4, FlexSearch, CompressionStream API, BetterAuth 1.5.5

**Spec:** `docs/superpowers/specs/2026-03-25-tiered-sync-design.md`

---

## File Map

### New — Elysia service
| File | Purpose |
|---|---|
| `services/mail/index.ts` | Entire Elysia service: routes, IMAP daemon, Drizzle, auth |
| `services/mail/package.json` | Runtime deps: elysia, imapflow, @libsql/client, drizzle-orm |
| `services/mail/tsconfig.json` | Bun-compatible TS config |
| `services/mail/drizzle.config.ts` | drizzle-kit config |
| `services/mail/drizzle/` | Generated migration files |

### New — Next.js client
| File | Purpose |
|---|---|
| `web/xedmail/src/lib/dexie.ts` | Dexie instance + schema v1 + TypeScript types |
| `web/xedmail/src/lib/search-index.ts` | FlexSearch Document index, build/search/snapshot |
| `web/xedmail/src/providers/sync-provider.tsx` | React context replacing jazz-provider; owns SSE + WS connections |
| `web/xedmail/src/hooks/use-inbox.ts` | `useInboxState()` — Dexie live query for emails/folders/mailboxes |
| `web/xedmail/src/hooks/use-email-body.ts` | `useEmailBody(id)` — Dexie cache + proxy fetch |
| `web/xedmail/src/app/api/mail/body/[id]/route.ts` | Next.js proxy → Elysia GET /body/:id |
| `web/xedmail/src/app/api/mail/attachments/[emailId]/[partId]/route.ts` | Next.js proxy → Elysia GET /attachments/:id/:part |

### Modified — Next.js
| File | Change |
|---|---|
| `web/xedmail/src/app/layout.tsx` | Swap `JazzProvider` → `SyncProvider` |
| `web/xedmail/src/app/inbox/page.tsx` | Rewrite: remove Jazz, use `useInboxState` + `useEmailBody` |
| `web/xedmail/src/components/inbox/inbox-client.tsx` | Remove Jazz imports; accept `EmailMetadata[]` instead of `EmailDto[]` |
| `web/xedmail/src/lib/auth.ts` | Remove `jazzPlugin()` |
| `web/xedmail/src/lib/db.ts` | Add `user_state` + `sender_rules` to `ensureDatabaseSchema()` |
| `web/xedmail/src/app/api/mail/search/route.ts` | Forward keyword fallback to Elysia `/search` |
| `web/xedmail/package.json` | Add dexie, flexsearch; remove jazz-tools |

### Deleted
- `web/xedmail/src/providers/jazz-provider.tsx`
- `web/xedmail/src/lib/jazz-schema.ts`

---

## Task 1: Elysia service scaffold

**Files:**
- Create: `services/mail/package.json`
- Create: `services/mail/tsconfig.json`
- Create: `services/mail/index.ts`

- [ ] **Step 1: Create `services/mail/package.json`**

```json
{
  "name": "xedmail-mail-service",
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "dev": "bun --watch index.ts",
    "start": "bun index.ts",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate"
  },
  "dependencies": {
    "elysia": "^1.2.0",
    "imapflow": "^1.0.0",
    "@libsql/client": "^0.14.0",
    "drizzle-orm": "^0.38.0"
  },
  "devDependencies": {
    "drizzle-kit": "^0.29.0",
    "bun-types": "latest"
  }
}
```

- [ ] **Step 2: Create `services/mail/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "types": ["bun-types"]
  }
}
```

- [ ] **Step 3: Create `services/mail/drizzle.config.ts`**

```typescript
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./index.ts",
  out: "./drizzle",
  dialect: "turso",
  dbCredentials: {
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN,
  },
});
```

- [ ] **Step 4: Create `services/mail/index.ts` with health endpoint only**

```typescript
import { Elysia } from "elysia";

const PORT = Number(process.env.PORT ?? 3001);

const app = new Elysia()
  .get("/health", () => ({ ok: true }))
  .listen(PORT);

console.log(`Mail service running on port ${PORT}`);

export type App = typeof app;
```

- [ ] **Step 5: Install deps and verify server starts**

```bash
cd services/mail && bun install && bun index.ts
```

Expected: `Mail service running on port 3001`

- [ ] **Step 6: Verify health endpoint**

```bash
curl http://localhost:3001/health
```

Expected: `{"ok":true}`

- [ ] **Step 7: Commit**

```bash
git add services/mail/
git commit -m "feat: scaffold Elysia mail service"
```

---

## Task 2: Drizzle schema + migrations

**Files:**
- Modify: `services/mail/index.ts` (add schema)
- Create: `services/mail/drizzle/` (generated)

- [ ] **Step 1: Add Drizzle schema to `services/mail/index.ts`** (insert after imports, before Elysia app)

```typescript
import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import { sqliteTable, text, integer, unique } from "drizzle-orm/sqlite-core";
import { eq, gt, and } from "drizzle-orm";

// --- Schema ---
const sessionTable = sqliteTable("session", {
  id:        text("id").primaryKey(),
  token:     text("token").notNull(),
  userId:    text("user_id").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
});

const mailboxes = sqliteTable("mailboxes", {
  id:                   text("id").primaryKey(),
  userId:               text("user_id").notNull(),
  emailAddress:         text("email_address").notNull(),
  accessToken:          text("access_token").notNull(),
  refreshToken:         text("refresh_token"),
  accessTokenExpiresAt: integer("access_token_expires_at"),
  isActive:             integer("is_active", { mode: "boolean" }).notNull().default(true),
});

const userState = sqliteTable("user_state", {
  id:           text("id").primaryKey(),
  userId:       text("user_id").notNull(),
  emailId:      text("email_id").notNull(),
  isArchived:   integer("is_archived", { mode: "boolean" }).notNull().default(false),
  snoozedUntil: integer("snoozed_until"),
  isReplied:    integer("is_replied", { mode: "boolean" }).notNull().default(false),
  createdAt:    integer("created_at").notNull(),
  updatedAt:    integer("updated_at").notNull(),
}, (t) => [unique().on(t.userId, t.emailId)]);

const senderRules = sqliteTable("sender_rules", {
  id:        text("id").primaryKey(),
  userId:    text("user_id").notNull(),
  address:   text("address").notNull(),
  rule:      text("rule", { enum: ["allow", "block"] }).notNull(),
  createdAt: integer("created_at").notNull(),
}, (t) => [unique().on(t.userId, t.address)]);

// --- DB client ---
function getDb() {
  const client = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
  return drizzle(client, { schema: { sessionTable, mailboxes, userState, senderRules } });
}

const db = getDb();
```

- [ ] **Step 2: Also add `user_state` + `sender_rules` to Next.js `db.ts`**

In `web/xedmail/src/lib/db.ts`, add to the `ensureDatabaseSchema()` batch:

```typescript
`CREATE TABLE IF NOT EXISTS user_state (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  email_id TEXT NOT NULL,
  is_archived INTEGER NOT NULL DEFAULT 0,
  snoozed_until INTEGER,
  is_replied INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, email_id)
);`,
`CREATE TABLE IF NOT EXISTS sender_rules (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  address TEXT NOT NULL,
  rule TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, address)
);`,
```

- [ ] **Step 3: Generate migrations**

```bash
cd services/mail
TURSO_DATABASE_URL=<your-url> TURSO_AUTH_TOKEN=<your-token> bun run db:generate
```

Expected: migration files created in `services/mail/drizzle/`

- [ ] **Step 4: Run migrations**

```bash
bun run db:migrate
```

- [ ] **Step 5: Commit**

```bash
git add services/mail/ web/xedmail/src/lib/db.ts
git commit -m "feat: add Drizzle schema and user_state/sender_rules migrations"
```

---

## Task 3: Auth middleware + CORS in Elysia

**Files:**
- Modify: `services/mail/index.ts`

- [ ] **Step 1: Add session validation helper to `services/mail/index.ts`**

```typescript
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
    req.headers.get("authorization")?.replace("Bearer ", "") ??
    undefined
  );
}
```

- [ ] **Step 2: Add CORS + auth plugin to Elysia app**

Replace the app definition:

```typescript
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "http://localhost:3000";
const SERVICE_SECRET = process.env.ELYSIA_SERVICE_SECRET ?? "";

const app = new Elysia()
  .onBeforeHandle(({ set }) => {
    set.headers["Access-Control-Allow-Origin"] = CORS_ORIGIN;
    set.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
    set.headers["Access-Control-Allow-Methods"] = "GET, OPTIONS";
  })
  .options("/*", () => new Response(null, { status: 204 }))
  .get("/health", () => ({ ok: true }))
  .listen(PORT);
```

- [ ] **Step 3: Verify CORS header appears**

```bash
curl -I http://localhost:3001/health
```

Expected: `Access-Control-Allow-Origin: http://localhost:3000`

- [ ] **Step 4: Commit**

```bash
git add services/mail/index.ts
git commit -m "feat: add CORS + BetterAuth session validation to Elysia"
```

---

## Task 4: IMAP daemon — connection management

**Files:**
- Modify: `services/mail/index.ts`

- [ ] **Step 1: Add EmailMetadata type and IMAP connection registry**

```typescript
import { ImapFlow } from "imapflow";

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
```

- [ ] **Step 2: Add IMAP message → EmailMetadata mapper**

```typescript
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
    snippet: extractSnippet(msg.bodyPart ?? ""),
    isRead: msg.flags?.has("\\Seen") ?? false,
    isStarred: msg.flags?.has("\\Flagged") ?? false,
    labels: Array.isArray(msg.gmailLabels) ? [...msg.gmailLabels] : [],
    hasAttachments: hasAttachmentParts(msg.bodyStructure),
  };
}
```

- [ ] **Step 3: Add fetchUidRange helper (used by both initial load and catchup)**

```typescript
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
```

- [ ] **Step 4: Commit**

```bash
git add services/mail/index.ts
git commit -m "feat: add IMAP connection registry and metadata mapper"
```

---

## Task 5: SSE `/stream` route

**Files:**
- Modify: `services/mail/index.ts`

- [ ] **Step 1: Add SSE stream route**

Add to the Elysia app before `.listen()`:

```typescript
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
          const startUid = cursor ?? (allUids[0] ?? 0);
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
```

- [ ] **Step 2: Verify SSE stream (manual test)**

Start the server with env vars set, then:

```bash
curl -N "http://localhost:3001/stream?mailbox=YOUR_EMAIL&token=YOUR_SESSION_TOKEN"
```

Expected: JSON `data:` events streaming in, ending with `backfill_complete`.

- [ ] **Step 3: Commit**

```bash
git add services/mail/index.ts
git commit -m "feat: add SSE /stream route with initial load + backfill"
```

---

## Task 6: WebSocket `/events` route

**Files:**
- Modify: `services/mail/index.ts`

- [ ] **Step 1: Add WebSocket route for real-time IMAP IDLE deltas**

```typescript
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
      connections.get(connKey)?.wsClients.delete(ws);
    }
  },
  message() {},
})
```

- [ ] **Step 2: Add `startIdleConnection` IMAP IDLE daemon**

```typescript
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
      reconnect(delayMs * 2);
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
```

- [ ] **Step 3: Commit**

```bash
git add services/mail/index.ts
git commit -m "feat: add WebSocket /events IMAP IDLE daemon with reconnection"
```

---

## Task 7: Body, attachment, and search routes in Elysia

**Files:**
- Modify: `services/mail/index.ts`

- [ ] **Step 1: Add body route**

```typescript
.get("/body/:emailId", async ({ params, request }) => {
  const secret = request.headers.get("x-service-secret");
  if (secret !== SERVICE_SECRET) return new Response("Forbidden", { status: 403 });

  const [mailboxAddress, uidStr] = params.emailId.split(":").reduce<[string, string]>((acc, part, i, arr) => {
    if (i < arr.length - 1) acc[0] = acc[0] ? `${acc[0]}:${part}` : part;
    else acc[1] = part;
    return acc;
  }, ["", ""]);
  const uid = Number(uidStr);

  const mb = await db.select().from(mailboxes)
    .where(eq(mailboxes.emailAddress, mailboxAddress)).limit(1);
  if (!mb[0]) return new Response("Not found", { status: 404 });

  const client = new ImapFlow({
    host: process.env.IMAP_HOST ?? "imap.gmail.com",
    port: Number(process.env.IMAP_PORT ?? 993),
    secure: process.env.IMAP_SECURE !== "false",
    auth: { user: mailboxAddress, accessToken: mb[0].accessToken },
    logger: false,
  });

  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try {
    const msg = await client.fetchOne(String(uid), { bodyStructure: true, source: true }, { uid: true });
    if (!msg) return new Response("Not found", { status: 404 });

    const body = msg.source?.toString("utf-8") ?? "";
    const attachments = extractAttachmentManifest(msg.bodyStructure);
    return Response.json({ body, attachments });
  } finally {
    lock.release();
    client.close();
  }
})
```

- [ ] **Step 2: Add attachment manifest extractor helper**

```typescript
type AttachmentManifest = { partId: string; filename: string; size: number; mimeType: string };

function extractAttachmentManifest(structure: any, path = ""): AttachmentManifest[] {
  if (!structure) return [];
  const results: AttachmentManifest[] = [];
  if (structure.disposition?.type?.toLowerCase() === "attachment") {
    results.push({
      partId: path || "1",
      filename: structure.disposition.parameters?.filename ?? "attachment",
      size: structure.size ?? 0,
      mimeType: `${structure.type}/${structure.subtype}`.toLowerCase(),
    });
  }
  if (Array.isArray(structure.childNodes)) {
    structure.childNodes.forEach((child: any, i: number) => {
      results.push(...extractAttachmentManifest(child, path ? `${path}.${i + 1}` : String(i + 1)));
    });
  }
  return results;
}
```

- [ ] **Step 3: Add attachment streaming route**

```typescript
.get("/attachments/:emailId/:partId", async ({ params, request }) => {
  const secret = request.headers.get("x-service-secret");
  if (secret !== SERVICE_SECRET) return new Response("Forbidden", { status: 403 });

  const emailId = params.emailId;
  const partId = params.partId;
  const lastColon = emailId.lastIndexOf(":");
  const mailboxAddress = emailId.slice(0, lastColon);
  const uid = Number(emailId.slice(lastColon + 1));

  const mb = await db.select().from(mailboxes)
    .where(eq(mailboxes.emailAddress, mailboxAddress)).limit(1);
  if (!mb[0]) return new Response("Not found", { status: 404 });

  const client = new ImapFlow({
    host: process.env.IMAP_HOST ?? "imap.gmail.com",
    port: Number(process.env.IMAP_PORT ?? 993),
    secure: process.env.IMAP_SECURE !== "false",
    auth: { user: mailboxAddress, accessToken: mb[0].accessToken },
    logger: false,
  });

  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  const download = await client.download(String(uid), partId, { uid: true });
  lock.release();
  // Stream directly — client.close() called after stream finishes
  const nodeStream = download.content;
  const webStream = new ReadableStream({
    start(controller) {
      nodeStream.on("data", (chunk: Buffer) => controller.enqueue(chunk));
      nodeStream.on("end", () => { controller.close(); client.close(); });
      nodeStream.on("error", (err) => { controller.error(err); client.close(); });
    },
  });
  return new Response(webStream, {
    headers: {
      "Content-Type": download.type ?? "application/octet-stream",
      "Content-Disposition": `attachment; filename="${download.disposition?.parameters?.filename ?? "file"}"`,
    },
  });
})
```

- [ ] **Step 4: Add IMAP SEARCH route**

```typescript
.get("/search", async ({ request }) => {
  const secret = request.headers.get("x-service-secret");
  if (secret !== SERVICE_SECRET) return new Response("Forbidden", { status: 403 });

  const url = new URL(request.url);
  const mailboxAddress = url.searchParams.get("mailbox") ?? "";
  const q = url.searchParams.get("q") ?? "";

  const mb = await db.select().from(mailboxes)
    .where(eq(mailboxes.emailAddress, mailboxAddress)).limit(1);
  if (!mb[0]) return Response.json({ emails: [] });

  const client = new ImapFlow({
    host: process.env.IMAP_HOST ?? "imap.gmail.com",
    port: Number(process.env.IMAP_PORT ?? 993),
    secure: process.env.IMAP_SECURE !== "false",
    auth: { user: mailboxAddress, accessToken: mb[0].accessToken },
    logger: false,
  });

  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try {
    const uids = await client.search({ text: q }, { uid: true });
    const emails = uids.length
      ? await fetchUidRange(client, mailboxAddress, uids.join(","))
      : [];
    return Response.json({ emails });
  } finally {
    lock.release();
    client.close();
  }
})
```

- [ ] **Step 5: Commit**

```bash
git add services/mail/index.ts
git commit -m "feat: add body, attachment, and search routes to Elysia service"
```

---

## Task 8: Dexie schema in Next.js

**Files:**
- Create: `web/xedmail/src/lib/dexie.ts`
- Modify: `web/xedmail/package.json`

- [ ] **Step 1: Install Dexie**

```bash
cd web/xedmail && npm install dexie
```

- [ ] **Step 2: Create `web/xedmail/src/lib/dexie.ts`**

```typescript
import Dexie, { type EntityTable } from "dexie";

export type EmailMetadata = {
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

export type CachedBody = {
  id: string;
  compressedData: Uint8Array;
  lastAccessed: number;
  byteSize: number;
};

export type SearchIndexRow = {
  field: string;
  snapshot: string;
};

export type SyncStateRow = {
  key: string;
  value: string; // JSON-serialised
};

export type RecentSearch = {
  id?: number;
  query: string;
  searchedAt: number;
};

class XedmailDB extends Dexie {
  emails!: EntityTable<EmailMetadata, "id">;
  bodies!: EntityTable<CachedBody, "id">;
  searchIndex!: EntityTable<SearchIndexRow, "field">;
  syncState!: EntityTable<SyncStateRow, "key">;
  recentSearches!: EntityTable<RecentSearch, "id">;

  constructor() {
    super("xedmail");
    this.version(1).stores({
      emails: "&id, mailboxId, date, fromAddress, isRead, threadId",
      bodies: "&id, lastAccessed, byteSize",
      searchIndex: "&field, snapshot",
      syncState: "&key, value",
      recentSearches: "++id, searchedAt",
    });
  }
}

export const db = new XedmailDB();

// --- syncState helpers ---
export async function getSyncState<T>(key: string, fallback: T): Promise<T> {
  const row = await db.syncState.get(key);
  return row ? (JSON.parse(row.value) as T) : fallback;
}

export async function setSyncState(key: string, value: unknown): Promise<void> {
  await db.syncState.put({ key, value: JSON.stringify(value) });
}
```

- [ ] **Step 3: Write a unit test for getSyncState/setSyncState**

Create `web/xedmail/src/lib/__tests__/dexie.test.ts`:

```typescript
import { beforeEach, describe, expect, it } from "vitest";
import "fake-indexeddb/auto";
import { db, getSyncState, setSyncState } from "../dexie";

describe("syncState helpers", () => {
  beforeEach(async () => { await db.syncState.clear(); });

  it("returns fallback when key missing", async () => {
    expect(await getSyncState("missing", 42)).toBe(42);
  });

  it("round-trips a value", async () => {
    await setSyncState("test", { a: 1 });
    expect(await getSyncState("test", null)).toEqual({ a: 1 });
  });
});
```

- [ ] **Step 4: Install test deps and run**

```bash
cd web/xedmail && npm install -D fake-indexeddb && npx vitest run src/lib/__tests__/dexie.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add web/xedmail/src/lib/dexie.ts web/xedmail/src/lib/__tests__/dexie.test.ts web/xedmail/package.json
git commit -m "feat: add Dexie schema and syncState helpers"
```

---

## Task 9: FlexSearch index module

**Files:**
- Create: `web/xedmail/src/lib/search-index.ts`
- Modify: `web/xedmail/package.json`

- [ ] **Step 1: Install FlexSearch**

```bash
cd web/xedmail && npm install flexsearch && npm install -D @types/flexsearch
```

- [ ] **Step 2: Create `web/xedmail/src/lib/search-index.ts`**

```typescript
import { Document } from "flexsearch";
import type { EmailMetadata } from "@/lib/dexie";
import { db } from "@/lib/dexie";

type IndexedEmail = Pick<EmailMetadata, "id" | "subject" | "fromName" | "fromAddress" | "snippet">;

let index: InstanceType<typeof Document<IndexedEmail>> | null = null;
let addedSinceSnapshot = 0;
const SNAPSHOT_EVERY = 500;

function getIndex() {
  if (!index) {
    index = new Document<IndexedEmail>({
      document: {
        id: "id",
        index: [
          { field: "subject",     tokenize: "forward" },
          { field: "fromName",    tokenize: "forward" },
          { field: "fromAddress", tokenize: "forward" },
          { field: "snippet",     tokenize: "forward" },
        ],
      },
      cache: true,
    });
  }
  return index;
}

export async function rehydrateIndex(): Promise<void> {
  const idx = getIndex();
  const rows = await db.searchIndex.toArray();
  for (const row of rows) {
    await (idx as any).import(row.field, row.snapshot);
  }
}

export async function addToIndex(emails: EmailMetadata[]): Promise<void> {
  const idx = getIndex();
  for (const e of emails) {
    idx.add({ id: e.id, subject: e.subject, fromName: e.fromName, fromAddress: e.fromAddress, snippet: e.snippet });
  }
  addedSinceSnapshot += emails.length;
  if (addedSinceSnapshot >= SNAPSHOT_EVERY) {
    addedSinceSnapshot = 0;
    void persistSnapshot();
  }
}

export async function removeFromIndex(id: string): Promise<void> {
  getIndex().remove(id);
}

async function persistSnapshot(): Promise<void> {
  const idx = getIndex();
  const fields = ["subject", "fromName", "fromAddress", "snippet"];
  for (const field of fields) {
    await new Promise<void>((resolve) => {
      (idx as any).export(field, async (key: string, data: string) => {
        if (data !== undefined) await db.searchIndex.put({ field: key, snapshot: data });
        resolve();
      });
    });
  }
}

export function searchIndex(query: string): string[] {
  if (!query.trim()) return [];
  const results = getIndex().search(query, { limit: 200, enrich: false });
  const ids = new Set<string>();
  for (const r of results) {
    for (const id of r.result as string[]) ids.add(id);
  }
  return [...ids];
}
```

- [ ] **Step 3: Write unit test**

Create `web/xedmail/src/lib/__tests__/search-index.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
// Reset module between tests
import { addToIndex, searchIndex } from "../search-index";

describe("searchIndex", () => {
  it("returns empty for empty query", () => {
    expect(searchIndex("")).toEqual([]);
  });

  it("finds added email by subject", async () => {
    await addToIndex([{
      id: "a@b.com:1", mailboxId: "a@b.com", uid: 1, threadId: "",
      subject: "Hello World", fromName: "Alice", fromAddress: "alice@x.com",
      date: 0, snippet: "", isRead: false, isStarred: false, labels: [], hasAttachments: false,
    }]);
    const results = searchIndex("hello");
    expect(results).toContain("a@b.com:1");
  });
});
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/lib/__tests__/search-index.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add web/xedmail/src/lib/search-index.ts web/xedmail/src/lib/__tests__/search-index.test.ts web/xedmail/package.json
git commit -m "feat: add FlexSearch index module with Dexie snapshot persistence"
```

---

## Task 10: SyncProvider — SSE + WebSocket consumer

**Files:**
- Create: `web/xedmail/src/providers/sync-provider.tsx`

- [ ] **Step 1: Create `web/xedmail/src/providers/sync-provider.tsx`**

```typescript
"use client";

import React, { createContext, useContext, useEffect, useRef } from "react";
import { useSession } from "@/lib/auth-client";
import { db, getSyncState, setSyncState } from "@/lib/dexie";
import { addToIndex, rehydrateIndex, removeFromIndex } from "@/lib/search-index";
import type { EmailMetadata } from "@/lib/dexie";

const ELYSIA_URL = process.env.NEXT_PUBLIC_ELYSIA_SERVICE_URL ?? "http://localhost:3001";

type SyncContextValue = { isReady: boolean };
const SyncContext = createContext<SyncContextValue>({ isReady: false });

async function writeBatch(emails: EmailMetadata[]) {
  await db.emails.bulkPut(emails);
  await addToIndex(emails);
}

async function openSSE(mailboxAddress: string, token: string) {
  const cursor = await getSyncState<number | null>(`backfillCursor_${mailboxAddress}`, null);
  const url = new URL(`${ELYSIA_URL}/stream`);
  url.searchParams.set("mailbox", mailboxAddress);
  url.searchParams.set("token", token);
  if (cursor) url.searchParams.set("cursor", String(cursor));

  const es = new EventSource(url.toString());

  es.onmessage = async (e) => {
    const msg = JSON.parse(e.data);

    if (msg.type === "batch") {
      const idleCallback: (fn: () => void) => void =
        typeof requestIdleCallback !== "undefined"
          ? (fn) => requestIdleCallback(fn)
          : (fn) => setTimeout(fn, 0);

      idleCallback(async () => {
        await writeBatch(msg.emails);
        if (msg.cursor) {
          await setSyncState(`backfillCursor_${mailboxAddress}`, msg.cursor);
        }
        // Update watermark from first batch
        const maxUid = Math.max(0, ...msg.emails.map((e: EmailMetadata) => e.uid));
        const current = await getSyncState<number>(`watermarkUid_${mailboxAddress}`, 0);
        if (maxUid > current) await setSyncState(`watermarkUid_${mailboxAddress}`, maxUid);
      });
    }

    if (msg.type === "backfill_complete") {
      await setSyncState(`backfillComplete_${mailboxAddress}`, true);
      await setSyncState(`watermarkUid_${mailboxAddress}`, msg.watermarkUid);
      es.close();
    }
  };

  es.onerror = () => es.close();
  return es;
}

function openWS(mailboxAddress: string, token: string) {
  const url = new URL(`${ELYSIA_URL.replace(/^http/, "ws")}/events`);
  url.searchParams.set("mailbox", mailboxAddress);
  url.searchParams.set("token", token);

  const ws = new WebSocket(url.toString());

  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data);

    if (msg.type === "exists") {
      await writeBatch(msg.emails);
    }
    if (msg.type === "expunge") {
      await db.emails.delete(msg.id);
      await db.bodies.delete(msg.id);
      removeFromIndex(msg.id);
    }
    if (msg.type === "flags") {
      await db.emails.where("id").equals(msg.id).modify({
        isRead: msg.isRead,
        isStarred: msg.isStarred,
      });
    }
    if (msg.type === "auth_error") {
      ws.close();
    }
  };

  return ws;
}

export function SyncProvider({ children }: { children: React.ReactNode }) {
  const { data: session } = useSession();
  const token = (session as any)?.session?.token as string | undefined;
  const esRefs = useRef<EventSource[]>([]);
  const wsRefs = useRef<WebSocket[]>([]);
  const [isReady, setIsReady] = React.useState(false);

  // Rehydrate FlexSearch from Dexie on mount
  useEffect(() => {
    rehydrateIndex().then(() => setIsReady(true));
  }, []);

  // Open SSE + WS for each mailbox when session is available
  useEffect(() => {
    if (!token) return;

    async function connect() {
      const mboxes = await fetch("/api/mail/mailboxes").then(r => r.json());
      const addresses: string[] = mboxes.map((m: { emailAddress: string }) => m.emailAddress);

      for (const addr of addresses) {
        // Re-open SSE if not complete
        const complete = await getSyncState<boolean>(`backfillComplete_${addr}`, false);
        if (!complete) {
          const es = await openSSE(addr, token!);
          esRefs.current.push(es);
        }
        const ws = openWS(addr, token!);
        wsRefs.current.push(ws);
      }
    }

    connect();

    return () => {
      esRefs.current.forEach(es => es.close());
      wsRefs.current.forEach(ws => ws.close());
      esRefs.current = [];
      wsRefs.current = [];
    };
  }, [token]);

  return (
    <SyncContext.Provider value={{ isReady }}>
      {children}
    </SyncContext.Provider>
  );
}

export function useSyncReady() {
  return useContext(SyncContext).isReady;
}
```

- [ ] **Step 2: Add `NEXT_PUBLIC_ELYSIA_SERVICE_URL` to `.env.local`**

```
NEXT_PUBLIC_ELYSIA_SERVICE_URL=http://localhost:3001
```

- [ ] **Step 3: Swap `JazzProvider` → `SyncProvider` in `layout.tsx`**

```typescript
// web/xedmail/src/app/layout.tsx
import { SyncProvider } from "@/providers/sync-provider";
// ...
<SyncProvider>{children}</SyncProvider>
```

- [ ] **Step 4: Commit**

```bash
git add web/xedmail/src/providers/sync-provider.tsx web/xedmail/src/app/layout.tsx web/xedmail/.env.local
git commit -m "feat: add SyncProvider with SSE + WebSocket Dexie consumer"
```

---

## Task 11: useInboxState hook (replaces useJazzInboxState)

**Files:**
- Create: `web/xedmail/src/hooks/use-inbox.ts`

- [ ] **Step 1: Create `web/xedmail/src/hooks/use-inbox.ts`**

```typescript
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/lib/dexie";
import type { EmailMetadata } from "@/lib/dexie";

export type { EmailMetadata };

export function useInboxEmails(mailboxId?: string): EmailMetadata[] {
  return useLiveQuery(
    () => mailboxId
      ? db.emails.where("mailboxId").equals(mailboxId).sortBy("date")
      : db.emails.orderBy("date").toArray(),
    [mailboxId],
    [],
  ) ?? [];
}

export function useAllInboxEmails(): EmailMetadata[] {
  return useLiveQuery(
    () => db.emails.orderBy("date").reverse().toArray(),
    [],
    [],
  ) ?? [];
}
```

- [ ] **Step 2: Install dexie-react-hooks**

```bash
cd web/xedmail && npm install dexie-react-hooks
```

- [ ] **Step 3: Commit**

```bash
git add web/xedmail/src/hooks/use-inbox.ts web/xedmail/package.json
git commit -m "feat: add useInboxEmails hook backed by Dexie live queries"
```

---

## Task 12: useEmailBody hook + proxy routes

**Files:**
- Create: `web/xedmail/src/hooks/use-email-body.ts`
- Create: `web/xedmail/src/app/api/mail/body/[id]/route.ts`
- Create: `web/xedmail/src/app/api/mail/attachments/[emailId]/[partId]/route.ts`

- [ ] **Step 1: Create `web/xedmail/src/app/api/mail/body/[id]/route.ts`**

```typescript
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
```

- [ ] **Step 2: Create `web/xedmail/src/app/api/mail/attachments/[emailId]/[partId]/route.ts`**

```typescript
export const runtime = "nodejs";
import { requireUserId } from "@/lib/api-auth";

const ELYSIA_URL = process.env.ELYSIA_SERVICE_URL!;
const SERVICE_SECRET = process.env.ELYSIA_SERVICE_SECRET!;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ emailId: string; partId: string }> }
) {
  await requireUserId();
  const { emailId, partId } = await params;
  return fetch(`${ELYSIA_URL}/attachments/${emailId}/${partId}`, {
    headers: { "x-service-secret": SERVICE_SECRET },
    cache: "no-store",
  });
}
```

- [ ] **Step 3: Create `web/xedmail/src/hooks/use-email-body.ts`**

```typescript
"use client";

import React from "react";
import { db } from "@/lib/dexie";

export type AttachmentManifest = {
  partId: string;
  filename: string;
  size: number;
  mimeType: string;
};

const MAX_CACHE_BYTES = Number(process.env.NEXT_PUBLIC_MAX_BODY_CACHE_MB ?? 500) * 1024 * 1024;

async function compress(text: string): Promise<{ data: Uint8Array; byteSize: number }> {
  const stream = new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); },
  }).pipeThrough(new CompressionStream("gzip"));
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream as AsyncIterable<Uint8Array>) chunks.push(chunk);
  const data = new Uint8Array(chunks.reduce((a, b) => a + b.byteLength, 0));
  let offset = 0;
  for (const c of chunks) { data.set(c, offset); offset += c.byteLength; }
  return { data, byteSize: data.byteLength };
}

async function decompress(data: Uint8Array): Promise<string> {
  const stream = new ReadableStream({
    start(c) { c.enqueue(data); c.close(); },
  }).pipeThrough(new DecompressionStream("gzip"));
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream as AsyncIterable<Uint8Array>) chunks.push(chunk);
  const all = new Uint8Array(chunks.reduce((a, b) => a + b.byteLength, 0));
  let offset = 0;
  for (const c of chunks) { all.set(c, offset); offset += c.byteLength; }
  return new TextDecoder().decode(all);
}

async function evict() {
  const total = await db.syncState.get("totalBodyBytes");
  let totalBytes = total ? JSON.parse(total.value) as number : 0;
  if (totalBytes <= MAX_CACHE_BYTES) return;
  const bodies = await db.bodies.orderBy("lastAccessed").toArray();
  for (const b of bodies) {
    if (totalBytes <= MAX_CACHE_BYTES) break;
    await db.bodies.delete(b.id);
    totalBytes -= b.byteSize;
  }
  await db.syncState.put({ key: "totalBodyBytes", value: JSON.stringify(Math.max(0, totalBytes)) });
}

export function useEmailBody(id: string | null) {
  const [body, setBody] = React.useState<string | null>(null);
  const [attachments, setAttachments] = React.useState<AttachmentManifest[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<Error | null>(null);

  React.useEffect(() => {
    if (!id) return;
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      try {
        // Cache hit
        const cached = await db.bodies.get(id!);
        if (cached) {
          await db.bodies.update(id!, { lastAccessed: Date.now() });
          const text = await decompress(cached.compressedData);
          if (!cancelled) setBody(text);
          setLoading(false);
          return;
        }

        // Cache miss — fetch via Next.js proxy
        const res = await fetch(`/api/mail/body/${id}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { body: rawBody, attachments: atts } = await res.json();

        if (!cancelled) {
          setBody(rawBody);
          setAttachments(atts ?? []);
        }

        // Cache if ≤ 5 MB compressed
        const { data, byteSize } = await compress(rawBody);
        const FIVE_MB = 5 * 1024 * 1024;
        if (byteSize <= FIVE_MB) {
          await db.bodies.put({ id: id!, compressedData: data, lastAccessed: Date.now(), byteSize });
          const prev = await db.syncState.get("totalBodyBytes");
          const prevBytes = prev ? JSON.parse(prev.value) as number : 0;
          await db.syncState.put({ key: "totalBodyBytes", value: JSON.stringify(prevBytes + byteSize) });
          void evict();
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [id]);

  return { body, attachments, loading, error };
}
```

- [ ] **Step 4: Add `ELYSIA_SERVICE_URL` and `ELYSIA_SERVICE_SECRET` to `.env.local`**

```
ELYSIA_SERVICE_URL=http://localhost:3001
ELYSIA_SERVICE_SECRET=dev-secret-change-in-prod
```

Also set `ELYSIA_SERVICE_SECRET` in `services/mail/` `.env` (create if needed):

```
ELYSIA_SERVICE_SECRET=dev-secret-change-in-prod
```

- [ ] **Step 5: Commit**

```bash
git add web/xedmail/src/hooks/use-email-body.ts \
        "web/xedmail/src/app/api/mail/body/[id]/route.ts" \
        "web/xedmail/src/app/api/mail/attachments/[emailId]/[partId]/route.ts"
git commit -m "feat: add useEmailBody hook with gzip cache + Next.js proxy routes"
```

---

## Task 13: Rewrite inbox page + update inbox-client

**Files:**
- Modify: `web/xedmail/src/app/inbox/page.tsx`
- Modify: `web/xedmail/src/components/inbox/inbox-client.tsx`

- [ ] **Step 1: Rewrite `web/xedmail/src/app/inbox/page.tsx`**

Replace the entire file:

```typescript
"use client";

import React, { useMemo } from "react";
import { useSearchParams } from "next/navigation";
import InboxClient from "@/components/inbox/inbox-client";
import { useAllInboxEmails } from "@/hooks/use-inbox";
import { searchIndex } from "@/lib/search-index";
import { getSyncState } from "@/lib/dexie";
import { useSyncReady } from "@/providers/sync-provider";

export default function Inbox() {
  const syncReady = useSyncReady();
  const emails = useAllInboxEmails();
  const searchParams = useSearchParams();
  const query = searchParams.get("query")?.trim() ?? "";

  const filteredEmails = useMemo(() => {
    if (!query) return emails;
    const matchedIds = new Set(searchIndex(query));
    if (matchedIds.size > 0) return emails.filter(e => matchedIds.has(e.id));

    // Fallback: server search handled in InboxClient via /api/mail/search
    return emails;
  }, [emails, query]);

  return (
    <InboxClient
      emails={filteredEmails}
      isLoading={!syncReady && emails.length === 0}
      query={query}
    />
  );
}
```

- [ ] **Step 2: Update `inbox-client.tsx` imports**

Replace the Jazz import and `Email` interface at the top of `inbox-client.tsx`:

```typescript
// Remove:
import { useJazzInboxState } from "@/providers/jazz-provider";

// Replace `Email` interface with:
import type { EmailMetadata } from "@/lib/dexie";
type Email = EmailMetadata & { body?: string };
```

Update the `InboxClient` props type to accept `EmailMetadata[]` instead of `EmailDto[]`. The `date` field is now a `number` (unix ms) — update `formatDate` and `formatFullDate` accordingly:

```typescript
function formatDate(dateMs: number) {
  const d = new Date(dateMs);
  const now = new Date();
  if (d.toDateString() === now.toDateString())
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}
```

Remove all `useJazzInboxState` calls inside `inbox-client.tsx` — snooze/archive actions will now call the new API routes (added next task).

- [ ] **Step 3: Commit**

```bash
git add web/xedmail/src/app/inbox/page.tsx web/xedmail/src/components/inbox/inbox-client.tsx
git commit -m "feat: rewrite inbox page and client to use Dexie + FlexSearch"
```

---

## Task 14: User state API routes (snooze, archive, sender rules)

**Files:**
- Modify: `web/xedmail/src/app/api/mail/emails/mailbox/[mailbox]/[uid]/archive/route.ts`
- Modify: `web/xedmail/src/app/api/mail/emails/mailbox/[mailbox]/[uid]/route.ts`

These routes previously wrote state to Jazz. Now they write to Turso `user_state`.

- [ ] **Step 1: Update archive route**

In `web/xedmail/src/app/api/mail/emails/mailbox/[mailbox]/[uid]/archive/route.ts`, replace the Jazz write with a Turso upsert using the existing `getDbClient()`:

```typescript
export const runtime = "nodejs";
import { requireUserId } from "@/lib/api-auth";
import { getDbClient } from "@/lib/db";
import { NextResponse } from "next/server";
import { randomUUID } from "crypto";

export async function POST(_req: Request, { params }: { params: Promise<{ mailbox: string; uid: string }> }) {
  const userId = await requireUserId();
  const { mailbox, uid } = await params;
  const emailId = `${mailbox}:${uid}`;
  const now = Date.now();
  const db = getDbClient();
  await db.execute({
    sql: `INSERT INTO user_state (id, user_id, email_id, is_archived, created_at, updated_at)
          VALUES (?, ?, ?, 1, ?, ?)
          ON CONFLICT(user_id, email_id) DO UPDATE SET is_archived = 1, updated_at = excluded.updated_at`,
    args: [randomUUID(), userId, emailId, now, now],
  });
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 2: Update snooze route similarly** (same pattern, sets `snoozed_until`)

- [ ] **Step 3: Commit**

```bash
git add web/xedmail/src/app/api/mail/emails/
git commit -m "feat: migrate snooze/archive state from Jazz to Turso user_state"
```

---

## Task 15: Remove Jazz

**Files:**
- Delete: `web/xedmail/src/providers/jazz-provider.tsx`
- Delete: `web/xedmail/src/lib/jazz-schema.ts`
- Modify: `web/xedmail/src/lib/auth.ts`
- Modify: `web/xedmail/package.json`

- [ ] **Step 1: Remove `jazzPlugin` from `auth.ts`**

In `web/xedmail/src/lib/auth.ts`:
- Remove the import: `import { jazzPlugin } from "jazz-tools/better-auth/auth/server";`
- Remove `jazzPlugin()` from the `plugins` array
- Remove the `user.update.before` database hook added in the previous session (it was only needed for Jazz credential backfill)

- [ ] **Step 2: Delete Jazz files**

```bash
rm web/xedmail/src/providers/jazz-provider.tsx
rm web/xedmail/src/lib/jazz-schema.ts
```

- [ ] **Step 3: Remove jazz-tools from package.json**

```bash
cd web/xedmail && npm uninstall jazz-tools
```

- [ ] **Step 4: Verify build**

```bash
cd web/xedmail && npm run build
```

Expected: build succeeds with no Jazz-related errors.

- [ ] **Step 5: Commit**

```bash
git add web/xedmail/src/lib/auth.ts web/xedmail/package.json
git rm web/xedmail/src/providers/jazz-provider.tsx web/xedmail/src/lib/jazz-schema.ts
git commit -m "chore: remove Jazz — delete jazz-provider, jazz-schema, jazzPlugin from auth"
```

---

## Task 16: Update search proxy route

**Files:**
- Modify: `web/xedmail/src/app/api/mail/search/route.ts`

- [ ] **Step 1: Replace IMAP search with Elysia proxy**

The existing `/api/mail/search` route runs IMAP directly in Next.js. Replace it with a proxy to Elysia `/search` for keyword queries:

```typescript
export const runtime = "nodejs";
import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/api-auth";
import { getValidMailboxesForUser } from "@/lib/mail-auth";

const ELYSIA_URL = process.env.ELYSIA_SERVICE_URL!;
const SERVICE_SECRET = process.env.ELYSIA_SERVICE_SECRET!;

export async function GET(request: Request) {
  const userId = await requireUserId();
  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q") ?? "";
  const mailboxParam = searchParams.get("mailbox");

  const mailboxes = await getValidMailboxesForUser(userId);
  const targets = mailboxParam
    ? mailboxes.filter(m => m.mailbox.emailAddress === mailboxParam)
    : mailboxes;

  const allEmails = await Promise.all(targets.map(async (m) => {
    const res = await fetch(
      `${ELYSIA_URL}/search?mailbox=${encodeURIComponent(m.mailbox.emailAddress)}&q=${encodeURIComponent(q)}`,
      { headers: { "x-service-secret": SERVICE_SECRET }, cache: "no-store" }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data.emails ?? [];
  }));

  return NextResponse.json({ emails: allEmails.flat() });
}
```

- [ ] **Step 2: Commit**

```bash
git add web/xedmail/src/app/api/mail/search/route.ts
git commit -m "feat: proxy /api/mail/search to Elysia IMAP SEARCH"
```

---

## Task 17: Startup body eviction + final wiring

**Files:**
- Modify: `web/xedmail/src/providers/sync-provider.tsx`

- [ ] **Step 1: Add startup eviction to SyncProvider**

In `SyncProvider`, add to the `useEffect` that calls `rehydrateIndex()`:

```typescript
useEffect(() => {
  async function init() {
    // Evict stale bodies (>30 days)
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const stale = await db.bodies.where("lastAccessed").below(thirtyDaysAgo).toArray();
    if (stale.length) {
      const freedBytes = stale.reduce((sum, b) => sum + b.byteSize, 0);
      await db.bodies.bulkDelete(stale.map(b => b.id));
      const prev = await getSyncState<number>("totalBodyBytes", 0);
      await setSyncState("totalBodyBytes", Math.max(0, prev - freedBytes));
    }

    await rehydrateIndex();
    setIsReady(true);
  }
  init();
}, []);
```

- [ ] **Step 2: Final smoke test — run both services**

```bash
# Terminal 1
cd services/mail && bun index.ts

# Terminal 2
cd web/xedmail && npm run dev
```

Open `http://localhost:3000` in the browser, sign in, navigate to `/inbox`. Verify:
- Emails load from Dexie (check DevTools → Application → IndexedDB → xedmail)
- SSE connection visible in Network tab to `localhost:3001/stream`
- WebSocket connection visible to `localhost:3001/events`
- Clicking an email triggers `/api/mail/body/:id` → body renders

- [ ] **Step 3: Commit**

```bash
git add web/xedmail/src/providers/sync-provider.tsx
git commit -m "feat: add startup body eviction to SyncProvider"
```

---

## Task 18: Environment variables + CLAUDE.md update

- [ ] **Step 1: Verify all required env vars are set in `.env.local`**

```
ELYSIA_SERVICE_URL=http://localhost:3001
ELYSIA_SERVICE_SECRET=dev-secret-change-in-prod
NEXT_PUBLIC_ELYSIA_SERVICE_URL=http://localhost:3001
```

And in `services/mail/.env`:

```
TURSO_DATABASE_URL=<same as Next.js>
TURSO_AUTH_TOKEN=<same as Next.js>
IMAP_HOST=imap.gmail.com
IMAP_PORT=993
IMAP_SECURE=true
ELYSIA_SERVICE_SECRET=dev-secret-change-in-prod
CORS_ORIGIN=http://localhost:3000
```

- [ ] **Step 2: Update `CLAUDE.md` env vars section** to add the new variables and remove Jazz references.

- [ ] **Step 3: Final commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md — add Elysia env vars, remove Jazz references"
```
