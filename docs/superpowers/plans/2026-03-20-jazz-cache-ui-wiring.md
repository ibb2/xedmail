# Jazz-first Cache & UI Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-poll IMAP fetches with Jazz-as-cache (UID watermark incremental sync) and wire up all dormant UI elements: Archive, Snooze, Reply with scheduled send, Gatekeeper, Settings navigation, and Prev/Next email navigation.

**Architecture:** Jazz holds the email cache as source of truth; the inbox page derives a `maxUid` per mailbox from Jazz and only fetches UIDs above that watermark on each poll. A new `mail-compose.ts` helper builds RFC 2822 messages for the Gmail REST API send endpoint. All UI actions (archive, snooze, allow/block, compose) call Jazz mutations or API routes; the polling loop resurfaces snoozed emails and syncs scheduled-send state.

**Tech Stack:** Next.js 15 App Router, React 19, Jazz-Tools 0.20, ImapFlow, Turso/libsql, Clerk, Biome (formatter/linter), `@libsql/client`, no test framework (tests are manual via `curl` and browser dev tools)

---

## File Map

### New files
| File | Responsibility |
|---|---|
| `web/xedmail/src/lib/mail-compose.ts` | `buildRfc2822` + `encodeMessage` helpers for Gmail REST API |
| `web/xedmail/src/app/api/mail/new/route.ts` | `GET` — incremental IMAP fetch above UID watermark |
| `web/xedmail/src/app/api/mail/emails/mailbox/[mailbox]/[uid]/archive/route.ts` | `POST` — Gmail archive (messageMove to All Mail) |
| `web/xedmail/src/app/api/mail/emails/send/route.ts` | `POST` — send email immediately via Gmail REST |
| `web/xedmail/src/app/api/mail/emails/schedule/route.ts` | `POST` — schedule a send, insert into Turso |
| `web/xedmail/src/app/api/mail/scheduled/route.ts` | `GET` — list unsent scheduled emails for current user |
| `web/xedmail/src/app/api/cron/send-scheduled/route.ts` | `GET` — cron job: claim and dispatch due scheduled emails |
| `web/xedmail/vercel.json` | Vercel Cron configuration |

### Modified files
| File | What changes |
|---|---|
| `web/xedmail/src/lib/jazz-schema.ts` | New CoMaps (`JazzSenderRule`, `JazzScheduledEmail`); new fields on `JazzMessage` and `JazzInboxState`; updated `resolved` map |
| `web/xedmail/src/providers/jazz-provider.tsx` | Init new lists in `ensureInboxState()`; append-merge in `syncInbox`; new context actions; updated `snoozeMessage` type |
| `web/xedmail/src/lib/mail-types.ts` | Add `snoozedUntil` and `isArchived` to `EmailDto` |
| `web/xedmail/src/lib/db.ts` | Add `scheduled_emails` DDL to `ensureDatabaseSchema()` |
| `web/xedmail/src/lib/mail-store.ts` | Add 5 new queries for scheduled emails |
| `web/xedmail/src/lib/google-oauth.ts` | Append `gmail.send` scope to `createGoogleAuthUrl` |
| `web/xedmail/src/lib/imap.ts` | Add `archiveEmail` function |
| `web/xedmail/src/app/inbox/page.tsx` | UID watermark polling, hybrid search, snooze resurface, scheduled sync |
| `web/xedmail/src/components/inbox/inbox-client.tsx` | Wire all UI: Archive, Snooze popover, Compose modal, Gatekeeper, Settings, Prev/Next |

---

## Task 1: Jazz Schema — New CoMaps and Fields

**Files:**
- Modify: `web/xedmail/src/lib/jazz-schema.ts`
- Modify: `web/xedmail/src/lib/mail-types.ts`

- [ ] **Step 1: Read the current schema**

  Open `src/lib/jazz-schema.ts`. You will see `JazzMailbox`, `JazzFolder`, `JazzMessage`, `JazzInboxState`, `JazzMailRoot`, `JazzMailAccount`.

- [ ] **Step 2: Add two new CoMaps above `JazzInboxState`**

  Insert after the `JazzMessage` definition:
  ```ts
  export const JazzSenderRule = co.map({
    address: z.string(),
    rule: z.enum(["allow", "block"]),
  });

  export const JazzScheduledEmail = co.map({
    id: z.string(),
    to: z.string(),
    subject: z.string(),
    sendAt: z.string(), // ISO date string
  });
  ```

- [ ] **Step 3: Extend `JazzMessage` with two new optional fields**

  Add to the existing `co.map({ ... })` call for `JazzMessage`:
  ```ts
  snoozedUntil: z.optional(z.string()),
  isArchived: z.optional(z.boolean()),
  ```

- [ ] **Step 4: Extend `JazzInboxState` with two new fields**

  Add to the existing `co.map({ ... })` call for `JazzInboxState`:
  ```ts
  senderRules: co.list(JazzSenderRule),
  scheduledEmails: co.list(JazzScheduledEmail),
  ```

- [ ] **Step 5: Update the `resolved` map on `JazzMailAccount`**

  The existing `.resolved({ root: { inboxState: { mailboxes, folders, messages } } })` call must include the two new lists:
  ```ts
  .resolved({
    root: {
      inboxState: {
        mailboxes: { $each: true },
        folders: { $each: true },
        messages: { $each: true },
        senderRules: { $each: true },
        scheduledEmails: { $each: true },
      },
    },
  })
  ```

- [ ] **Step 6: Add `snoozedUntil` and `isArchived` to `EmailDto` in `mail-types.ts`**

  ```ts
  export type EmailDto = {
    id: string;
    uid: string;
    mailboxAddress: string;
    subject: string;
    from: [string, string];
    to: string;
    body?: string;
    date: string;
    isRead: boolean;
    isNew?: boolean;
    snoozedUntil?: string;   // new
    isArchived?: boolean;    // new
  };
  ```

- [ ] **Step 7: Verify the build compiles**

  ```bash
  cd web/xedmail && npm run build 2>&1 | head -40
  ```
  Expected: no TypeScript errors on the schema or mail-types files.

- [ ] **Step 8: Commit**

  ```bash
  git add web/xedmail/src/lib/jazz-schema.ts web/xedmail/src/lib/mail-types.ts
  git commit -m "feat: add JazzSenderRule, JazzScheduledEmail; extend schema and EmailDto"
  ```

---

## Task 2: DB Schema — `scheduled_emails` Table

**Files:**
- Modify: `web/xedmail/src/lib/db.ts`

- [ ] **Step 1: Add the DDL inside `ensureDatabaseSchema()`**

  The function calls `db.batch([...], "write")` with an array of SQL strings. Add a fourth string to that array:
  ```ts
  `
  CREATE TABLE IF NOT EXISTS scheduled_emails (
    id TEXT PRIMARY KEY,
    clerk_user_id TEXT NOT NULL,
    mailbox_address TEXT NOT NULL,
    to_address TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    in_reply_to TEXT,
    references TEXT,
    send_at INTEGER NOT NULL,
    sent INTEGER NOT NULL DEFAULT 0,
    sending INTEGER NOT NULL DEFAULT 0
  );
  `,
  ```

  `send_at` stores unix milliseconds. `sending` is the idempotency lock (set to 1 while the cron is processing a row; prevents double-send on concurrent cron invocations).

- [ ] **Step 2: Verify the batch array syntax**

  Check the comma after the third existing SQL string is present and the new string is inside the array brackets.

- [ ] **Step 3: Commit**

  ```bash
  git add web/xedmail/src/lib/db.ts
  git commit -m "feat: add scheduled_emails table to db schema"
  ```

---

## Task 3: `mail-store.ts` — Scheduled Email Queries

**Files:**
- Modify: `web/xedmail/src/lib/mail-store.ts`

- [ ] **Step 1: Add `ScheduledEmailRecord` type at the top of `mail-store.ts`**

  ```ts
  export type ScheduledEmailRecord = {
    id: string;
    clerkUserId: string;
    mailboxAddress: string;
    toAddress: string;
    subject: string;
    body: string;
    inReplyTo: string | null;
    references: string | null;
    sendAt: number; // unix ms
    sent: boolean;
    sending: boolean;
  };
  ```

- [ ] **Step 2: Add `rowToScheduledEmail` helper (private, not exported)**

  ```ts
  function rowToScheduledEmail(row: Row): ScheduledEmailRecord {
    return {
      id: String(row.id),
      clerkUserId: String(row.clerk_user_id),
      mailboxAddress: String(row.mailbox_address),
      toAddress: String(row.to_address),
      subject: String(row.subject),
      body: String(row.body),
      inReplyTo: row.in_reply_to ? String(row.in_reply_to) : null,
      references: row.references ? String(row.references) : null,
      sendAt: Number(row.send_at),
      sent: Number(row.sent) === 1,
      sending: Number(row.sending) === 1,
    };
  }
  ```

- [ ] **Step 3: Add `insertScheduledEmail`**

  ```ts
  export async function insertScheduledEmail(opts: {
    id: string;
    clerkUserId: string;
    mailboxAddress: string;
    toAddress: string;
    subject: string;
    body: string;
    inReplyTo?: string | null;
    references?: string | null;
    sendAt: number; // unix ms
  }): Promise<void> {
    await ensureDatabaseSchema();
    const db = getDbClient();
    await db.execute({
      sql: `
        INSERT INTO scheduled_emails
          (id, clerk_user_id, mailbox_address, to_address, subject, body,
           in_reply_to, references, send_at, sent, sending)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
      `,
      args: [
        opts.id, opts.clerkUserId, opts.mailboxAddress, opts.toAddress,
        opts.subject, opts.body,
        opts.inReplyTo ?? null, opts.references ?? null, opts.sendAt,
      ],
    });
  }
  ```

- [ ] **Step 4: Add `getUnsentScheduledEmailsForUser`**

  ```ts
  export async function getUnsentScheduledEmailsForUser(
    clerkUserId: string,
  ): Promise<ScheduledEmailRecord[]> {
    await ensureDatabaseSchema();
    const db = getDbClient();
    const result = await db.execute({
      sql: `SELECT * FROM scheduled_emails WHERE clerk_user_id = ? AND sent = 0 ORDER BY send_at ASC`,
      args: [clerkUserId],
    });
    return result.rows.map(rowToScheduledEmail);
  }
  ```

- [ ] **Step 5: Add `resetStuckScheduledEmails` (TTL recovery)**

  ```ts
  export async function resetStuckScheduledEmails(beforeMs: number): Promise<void> {
    await ensureDatabaseSchema();
    const db = getDbClient();
    await db.execute({
      sql: `UPDATE scheduled_emails SET sending = 0 WHERE sent = 0 AND sending = 1 AND send_at <= ?`,
      args: [beforeMs],
    });
  }
  ```

- [ ] **Step 6: Add `claimDueScheduledEmails` — atomic via transaction**

  The claim must be atomic: UPDATE then SELECT must run inside a single Turso transaction to prevent a concurrent cron invocation from claiming the same rows between the two statements.

  ```ts
  export async function claimDueScheduledEmails(
    nowMs: number,
  ): Promise<ScheduledEmailRecord[]> {
    await ensureDatabaseSchema();
    const db = getDbClient();
    const tx = await db.transaction("write");
    try {
      await tx.execute({
        sql: `UPDATE scheduled_emails SET sending = 1 WHERE sent = 0 AND sending = 0 AND send_at <= ?`,
        args: [nowMs],
      });
      const result = await tx.execute({
        sql: `SELECT * FROM scheduled_emails WHERE sent = 0 AND sending = 1 AND send_at <= ?`,
        args: [nowMs],
      });
      await tx.commit();
      return result.rows.map(rowToScheduledEmail);
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }
  ```

- [ ] **Step 7: Add `markScheduledEmailSent` and `clearScheduledEmailLock`**

  ```ts
  export async function markScheduledEmailSent(id: string): Promise<void> {
    await ensureDatabaseSchema();
    const db = getDbClient();
    await db.execute({
      sql: `UPDATE scheduled_emails SET sent = 1, sending = 0 WHERE id = ?`,
      args: [id],
    });
  }

  export async function clearScheduledEmailLock(id: string): Promise<void> {
    await ensureDatabaseSchema();
    const db = getDbClient();
    await db.execute({
      sql: `UPDATE scheduled_emails SET sending = 0 WHERE id = ?`,
      args: [id],
    });
  }
  ```

- [ ] **Step 8: Verify lint passes**

  ```bash
  cd web/xedmail && npm run lint 2>&1 | head -30
  ```

- [ ] **Step 9: Commit**

  ```bash
  git add web/xedmail/src/lib/mail-store.ts
  git commit -m "feat: add scheduled email queries to mail-store"
  ```

---

## Task 4: `mail-compose.ts` — RFC 2822 Builder

**Files:**
- Create: `web/xedmail/src/lib/mail-compose.ts`

- [ ] **Step 1: Create the file**

  ```ts
  // src/lib/mail-compose.ts
  // Builds RFC 2822 plain-text messages for the Gmail REST API send endpoint.
  // No external library is needed for plain-text-only sends.

  export type ComposeOpts = {
    from: string;
    to: string;
    subject: string;
    body: string;
    inReplyTo?: string;
    references?: string;
  };

  export function buildRfc2822(opts: ComposeOpts): string {
    const date = new Date().toUTCString();
    const lines: string[] = [
      `From: ${opts.from}`,
      `To: ${opts.to}`,
      `Subject: ${opts.subject}`,
      `Date: ${date}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset=utf-8`,
    ];

    if (opts.inReplyTo) lines.push(`In-Reply-To: ${opts.inReplyTo}`);
    if (opts.references) lines.push(`References: ${opts.references}`);

    return `${lines.join("\r\n")}\r\n\r\n${opts.body}`;
  }

  export function encodeMessage(raw: string): string {
    return Buffer.from(raw).toString("base64url");
  }
  ```

- [ ] **Step 2: Verify the output manually**

  Temporarily add a script file (delete after), or run in Node REPL:
  ```bash
  node -e "
  const { buildRfc2822, encodeMessage } = require('./src/lib/mail-compose');
  const raw = buildRfc2822({ from: 'a@a.com', to: 'b@b.com', subject: 'Hello', body: 'World' });
  console.log(raw.split('\r\n').slice(0, 6).join('\n'));
  console.log('encoded:', encodeMessage(raw).slice(0, 20) + '...');
  "
  ```
  Expected: headers printed correctly, encoded is a non-empty base64url string.

- [ ] **Step 3: Commit**

  ```bash
  git add web/xedmail/src/lib/mail-compose.ts
  git commit -m "feat: add mail-compose RFC 2822 builder"
  ```

---

## Task 5: `imap.ts` — `archiveEmail` Helper

**Files:**
- Modify: `web/xedmail/src/lib/imap.ts`

- [ ] **Step 1: Add `archiveEmail` at the bottom of `imap.ts`**

  ```ts
  export async function archiveEmail(
    auth: ImapAuth,
    uid: string,
  ): Promise<void> {
    await withImapClient(auth, async (client) => {
      const lock = await client.getMailboxLock(INBOX);
      try {
        await client.messageMove(uid, "[Gmail]/All Mail", { uid: true });
      } finally {
        lock.release();
      }
    });
  }
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add web/xedmail/src/lib/imap.ts
  git commit -m "feat: add archiveEmail IMAP helper"
  ```

---

## Task 6: `google-oauth.ts` — Add `gmail.send` Scope

**Files:**
- Modify: `web/xedmail/src/lib/google-oauth.ts`

- [ ] **Step 1: Update the scope string in `createGoogleAuthUrl`**

  Change line 19 from:
  ```ts
  scope: "openid https://mail.google.com/ profile email",
  ```
  To:
  ```ts
  scope: "openid https://mail.google.com/ profile email https://www.googleapis.com/auth/gmail.send",
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add web/xedmail/src/lib/google-oauth.ts
  git commit -m "feat: add gmail.send scope to OAuth flow"
  ```

  > **Note for humans:** existing connected mailboxes were authorized without `gmail.send`. When a user attempts to send and hits a 403, the API returns `{ error: "INSUFFICIENT_SCOPE" }`. The user must reconnect their mailbox via Settings — the new scope will be requested on the consent screen.

---

## Task 7: API Route — `GET /api/mail/new`

**Files:**
- Create: `web/xedmail/src/app/api/mail/new/route.ts`

- [ ] **Step 1: Create the route**

  ```ts
  import { NextResponse } from "next/server";
  import { requireClerkUserId } from "@/lib/api-auth";
  import { withImapClient } from "@/lib/imap";
  import { getValidMailboxForUser } from "@/lib/mail-auth";
  import type { EmailDto } from "@/lib/mail-types";

  export const runtime = "nodejs";

  const INBOX = process.env.IMAP_INBOX_NAME ?? "INBOX";
  const LIMIT = 50;

  export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const minUidParam = searchParams.get("minUid");
    const mailbox = searchParams.get("mailbox");

    if (!mailbox || minUidParam === null) {
      return NextResponse.json({ error: "minUid and mailbox are required" }, { status: 400 });
    }

    const minUid = parseInt(minUidParam, 10);
    if (Number.isNaN(minUid)) {
      return NextResponse.json({ error: "minUid must be an integer" }, { status: 400 });
    }

    try {
      const clerkUserId = await requireClerkUserId();
      const { mailbox: mailboxRecord, accessToken } = await getValidMailboxForUser(
        clerkUserId,
        decodeURIComponent(mailbox),
      );

      const emails: EmailDto[] = await withImapClient(
        { email: mailboxRecord.emailAddress, accessToken },
        async (client) => {
          const lock = await client.getMailboxLock(INBOX);
          const results: EmailDto[] = [];
          try {
            for await (const msg of client.fetch(
              `${minUid + 1}:*`,
              { uid: true, envelope: true, flags: true, internalDate: true },
              { uid: true },
            )) {
              const envelope = msg.envelope;
              const from = envelope?.from?.[0];
              const to =
                envelope?.to?.map((e: { address?: string }) => e.address).filter(Boolean).join(", ") ?? "unknown";
              const date = msg.internalDate
                ? new Date(msg.internalDate).toISOString()
                : new Date().toISOString();

              results.push({
                id: `${mailboxRecord.emailAddress}:${msg.uid}`,
                uid: String(msg.uid),
                mailboxAddress: mailboxRecord.emailAddress,
                subject: envelope?.subject ?? "(No Subject)",
                from: [from?.name ?? "Unknown", from?.address ?? "unknown"],
                to,
                date,
                isRead: msg.flags?.has("\\Seen") ?? false,
              });

              if (results.length >= LIMIT) break;
            }
          } finally {
            lock.release();
          }
          return results;
        },
      );

      return NextResponse.json({ emails });
    } catch (error) {
      if (error instanceof Error && error.message === "UNAUTHORIZED") {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      if (error instanceof Error && error.message === "MAILBOX_NOT_FOUND") {
        return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
      }
      return NextResponse.json({ error: "Failed to fetch new messages" }, { status: 500 });
    }
  }
  ```

- [ ] **Step 2: Test manually (requires dev server running and a Clerk session token)**

  ```bash
  curl -H "Authorization: Bearer <clerk-token>" \
    "http://localhost:3000/api/mail/new?minUid=0&mailbox=you%40gmail.com"
  ```
  Expected: `{ "emails": [...] }` — all inbox messages (minUid=0 means fetch everything).

- [ ] **Step 3: Commit**

  ```bash
  git add web/xedmail/src/app/api/mail/new/route.ts
  git commit -m "feat: add GET /api/mail/new incremental IMAP fetch"
  ```

---

## Task 8: API Route — Archive

**Files:**
- Create: `web/xedmail/src/app/api/mail/emails/mailbox/[mailbox]/[uid]/archive/route.ts`

  This file lives in a new `archive/` subdirectory inside the existing `[uid]/` directory. The existing `[uid]/route.ts` (PATCH read-status) is **not modified or touched**.

- [ ] **Step 1: Create the directory**

  ```bash
  mkdir -p "web/xedmail/src/app/api/mail/emails/mailbox/[mailbox]/[uid]/archive"
  ```

- [ ] **Step 2: Create `route.ts`**

  ```ts
  import { NextResponse } from "next/server";
  import { requireClerkUserId } from "@/lib/api-auth";
  import { archiveEmail } from "@/lib/imap";
  import { getValidMailboxForUser } from "@/lib/mail-auth";

  export const runtime = "nodejs";

  type Context = {
    params: Promise<{ mailbox: string; uid: string }>;
  };

  export async function POST(_request: Request, context: Context) {
    const { mailbox, uid } = await context.params;
    const decodedMailbox = decodeURIComponent(mailbox);

    try {
      const clerkUserId = await requireClerkUserId();
      const { mailbox: mailboxRecord, accessToken } = await getValidMailboxForUser(
        clerkUserId,
        decodedMailbox,
      );

      const imapHost = process.env.IMAP_HOST ?? "imap.gmail.com";
      if (imapHost !== "imap.gmail.com") {
        return NextResponse.json({ error: "Unsupported provider" }, { status: 400 });
      }

      await archiveEmail({ email: mailboxRecord.emailAddress, accessToken }, uid);

      return new NextResponse(null, { status: 204 });
    } catch (error) {
      if (error instanceof Error && error.message === "UNAUTHORIZED") {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      if (error instanceof Error && error.message === "MAILBOX_NOT_FOUND") {
        return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
      }
      return NextResponse.json({ error: "Failed to archive message" }, { status: 500 });
    }
  }
  ```

- [ ] **Step 3: Test manually**

  ```bash
  curl -X POST -H "Authorization: Bearer <clerk-token>" \
    "http://localhost:3000/api/mail/emails/mailbox/you%40gmail.com/12345/archive"
  ```
  Expected: `204`. Verify in Gmail that the email moved out of Inbox into All Mail.

- [ ] **Step 4: Commit**

  ```bash
  git add "web/xedmail/src/app/api/mail/emails/mailbox/[mailbox]/[uid]/archive/route.ts"
  git commit -m "feat: add POST archive route for Gmail IMAP messageMove"
  ```

---

## Task 9: API Routes — Send, Schedule, Scheduled

**Files:**
- Create: `web/xedmail/src/app/api/mail/emails/send/route.ts`
- Create: `web/xedmail/src/app/api/mail/emails/schedule/route.ts`
- Create: `web/xedmail/src/app/api/mail/scheduled/route.ts`

- [ ] **Step 1: Create `send/route.ts`**

  ```ts
  import { NextResponse } from "next/server";
  import { requireClerkUserId } from "@/lib/api-auth";
  import { buildRfc2822, encodeMessage } from "@/lib/mail-compose";
  import { getValidMailboxForUser } from "@/lib/mail-auth";

  export const runtime = "nodejs";

  const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

  export async function POST(request: Request) {
    try {
      const body = await request.json() as {
        mailbox: string; to: string; subject: string; body: string;
        inReplyTo?: string; references?: string;
      };

      const clerkUserId = await requireClerkUserId();
      const { mailbox: mailboxRecord, accessToken } = await getValidMailboxForUser(
        clerkUserId, body.mailbox,
      );

      const raw = buildRfc2822({
        from: mailboxRecord.emailAddress,
        to: body.to, subject: body.subject, body: body.body,
        inReplyTo: body.inReplyTo, references: body.references,
      });

      const response = await fetch(GMAIL_SEND_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ raw: encodeMessage(raw) }),
      });

      if (response.status === 403) {
        return NextResponse.json({ error: "INSUFFICIENT_SCOPE" });
      }
      if (!response.ok) {
        const text = await response.text();
        return NextResponse.json({ error: `Gmail send failed: ${text}` }, { status: 500 });
      }

      const result = await response.json() as { id: string };
      return NextResponse.json({ messageId: result.id });
    } catch (error) {
      if (error instanceof Error && error.message === "UNAUTHORIZED") {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      if (error instanceof Error && error.message === "MAILBOX_NOT_FOUND") {
        return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
      }
      return NextResponse.json({ error: "Failed to send message" }, { status: 500 });
    }
  }
  ```

- [ ] **Step 2: Create `schedule/route.ts`**

  ```ts
  import { randomUUID } from "crypto";
  import { NextResponse } from "next/server";
  import { requireClerkUserId } from "@/lib/api-auth";
  import { getValidMailboxForUser } from "@/lib/mail-auth";
  import { insertScheduledEmail } from "@/lib/mail-store";

  export const runtime = "nodejs";

  export async function POST(request: Request) {
    try {
      const body = await request.json() as {
        mailbox: string; to: string; subject: string; body: string;
        inReplyTo?: string; references?: string; sendAt: string;
      };

      const clerkUserId = await requireClerkUserId();
      const { mailbox: mailboxRecord } = await getValidMailboxForUser(clerkUserId, body.mailbox);

      const id = randomUUID();
      await insertScheduledEmail({
        id, clerkUserId,
        mailboxAddress: mailboxRecord.emailAddress,
        toAddress: body.to, subject: body.subject, body: body.body,
        inReplyTo: body.inReplyTo ?? null, references: body.references ?? null,
        sendAt: Date.parse(body.sendAt), // ISO string → unix ms
      });

      return NextResponse.json({ id }, { status: 201 });
    } catch (error) {
      if (error instanceof Error && error.message === "UNAUTHORIZED") {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      if (error instanceof Error && error.message === "MAILBOX_NOT_FOUND") {
        return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
      }
      return NextResponse.json({ error: "Failed to schedule message" }, { status: 500 });
    }
  }
  ```

- [ ] **Step 3: Create `scheduled/route.ts`**

  ```ts
  import { NextResponse } from "next/server";
  import { requireClerkUserId } from "@/lib/api-auth";
  import { getUnsentScheduledEmailsForUser } from "@/lib/mail-store";

  export const runtime = "nodejs";

  export async function GET() {
    try {
      const clerkUserId = await requireClerkUserId();
      const rows = await getUnsentScheduledEmailsForUser(clerkUserId);
      const scheduled = rows.map((row) => ({
        id: row.id, to: row.toAddress, subject: row.subject,
        sendAt: new Date(row.sendAt).toISOString(),
      }));
      return NextResponse.json({ scheduled });
    } catch (error) {
      if (error instanceof Error && error.message === "UNAUTHORIZED") {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      return NextResponse.json({ error: "Failed to fetch scheduled emails" }, { status: 500 });
    }
  }
  ```

- [ ] **Step 4: Test manually**

  ```bash
  # Schedule an email
  curl -X POST -H "Authorization: Bearer <clerk-token>" \
    -H "Content-Type: application/json" \
    -d '{"mailbox":"you@gmail.com","to":"t@t.com","subject":"S","body":"B","sendAt":"2026-12-01T09:00:00.000Z"}' \
    http://localhost:3000/api/mail/emails/schedule
  # Expected: { "id": "..." }

  # List scheduled
  curl -H "Authorization: Bearer <clerk-token>" http://localhost:3000/api/mail/scheduled
  # Expected: { "scheduled": [{ "id": "...", "to": "t@t.com", "subject": "S", "sendAt": "..." }] }
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add web/xedmail/src/app/api/mail/emails/send/route.ts \
          web/xedmail/src/app/api/mail/emails/schedule/route.ts \
          web/xedmail/src/app/api/mail/scheduled/route.ts
  git commit -m "feat: add send, schedule, and scheduled email API routes"
  ```

---

## Task 10: API Route — Cron Send-Scheduled + `vercel.json`

**Files:**
- Create: `web/xedmail/src/app/api/cron/send-scheduled/route.ts`
- Create: `web/xedmail/vercel.json`

- [ ] **Step 1: Create `send-scheduled/route.ts`**

  ```ts
  import { NextResponse } from "next/server";
  import { buildRfc2822, encodeMessage } from "@/lib/mail-compose";
  import { getValidMailboxForUser } from "@/lib/mail-auth";
  import {
    claimDueScheduledEmails, clearScheduledEmailLock,
    markScheduledEmailSent, resetStuckScheduledEmails,
  } from "@/lib/mail-store";

  export const runtime = "nodejs";

  const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

  export async function GET(request: Request) {
    const authHeader = request.headers.get("authorization");
    const cronSecret = process.env.CRON_SECRET;

    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const now = Date.now();

    // TTL recovery: reset rows stuck in sending=1 for >5 minutes (crash recovery)
    await resetStuckScheduledEmails(now - 5 * 60 * 1000);

    // Atomically claim rows due now (uses a DB transaction — see mail-store.ts)
    const rows = await claimDueScheduledEmails(now);

    let sent = 0;
    for (const row of rows) {
      try {
        const { mailbox: mailboxRecord, accessToken } = await getValidMailboxForUser(
          row.clerkUserId, row.mailboxAddress,
        );

        const raw = buildRfc2822({
          from: mailboxRecord.emailAddress,
          to: row.toAddress, subject: row.subject, body: row.body,
          inReplyTo: row.inReplyTo ?? undefined,
          references: row.references ?? undefined,
        });

        const response = await fetch(GMAIL_SEND_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ raw: encodeMessage(raw) }),
        });

        if (response.ok) {
          await markScheduledEmailSent(row.id);
          sent++;
        } else {
          await clearScheduledEmailLock(row.id); // retry next tick
        }
      } catch {
        await clearScheduledEmailLock(row.id); // retry next tick
      }
    }

    return NextResponse.json({ sent });
  }
  ```

- [ ] **Step 2: Create `vercel.json` in `web/xedmail/`**

  ```json
  {
    "crons": [
      { "path": "/api/cron/send-scheduled", "schedule": "* * * * *" }
    ]
  }
  ```

  > **Note:** `* * * * *` (every minute) requires Vercel Pro. Change to `"0 * * * *"` for Hobby.

- [ ] **Step 3: Add `CRON_SECRET` to `.env.local` (do not commit this file)**

  Add to `web/xedmail/.env.local`:
  ```
  CRON_SECRET=some-long-random-string
  ```

- [ ] **Step 4: Test the cron manually**

  With a scheduled email row in the DB that has `send_at` in the past:
  ```bash
  curl -H "Authorization: Bearer some-long-random-string" \
    http://localhost:3000/api/cron/send-scheduled
  ```
  Expected: `{ "sent": 1 }`. Verify the email arrived in Gmail Sent.

- [ ] **Step 5: Commit (exclude `.env.local` — it is gitignored)**

  ```bash
  git add web/xedmail/src/app/api/cron/send-scheduled/route.ts web/xedmail/vercel.json
  git commit -m "feat: add cron send-scheduled route and vercel.json"
  ```

---

## Task 11: Jazz Provider — Init, Append-Merge, New Actions

**Files:**
- Modify: `web/xedmail/src/providers/jazz-provider.tsx`

Read the entire current file before making changes — it is long and must be modified in several coordinated places.

- [ ] **Step 1: Update `JazzInboxContextValue` type**

  Replace the existing type definition with:
  ```ts
  type JazzInboxContextValue = {
    messages: EmailDto[];
    folders: FolderDto[];
    mailboxes: MailboxDto[];
    scheduledEmails: Array<{ id: string; to: string; subject: string; sendAt: string }>;
    senderRules: Array<{ address: string; rule: "allow" | "block" }>;
    syncInbox: (payload: { messages: EmailDto[]; folders: FolderDto[]; mailboxes: MailboxDto[] }) => void;
    updateMessageReadStatus: (target: Pick<EmailDto, "uid" | "mailboxAddress">, isRead: boolean) => void;
    clearMessageNewStatus: (target: Pick<EmailDto, "uid" | "mailboxAddress">) => void;
    archiveMessage: (target: Pick<EmailDto, "uid" | "mailboxAddress">) => void;
    snoozeMessage: (target: Pick<EmailDto, "uid" | "mailboxAddress">, until: string | undefined) => void;
    allowSender: (address: string) => void;
    blockSender: (address: string) => void;
    syncScheduledEmails: (emails: Array<{ id: string; to: string; subject: string; sendAt: string }>) => void;
  };
  ```

  Note: `snoozeMessage` takes `until: string | undefined` — passing `undefined` resurfaces the email.

- [ ] **Step 2: Update the default context value (returned when `!me.$isLoaded`)**

  ```ts
  if (!me.$isLoaded) {
    return {
      messages: [], folders: [], mailboxes: [],
      scheduledEmails: [], senderRules: [],
      syncInbox: () => undefined,
      updateMessageReadStatus: () => undefined,
      clearMessageNewStatus: () => undefined,
      archiveMessage: () => undefined,
      snoozeMessage: () => undefined,
      allowSender: () => undefined,
      blockSender: () => undefined,
      syncScheduledEmails: () => undefined,
    };
  }
  ```

- [ ] **Step 3: Update `ensureInboxState()` to initialize new lists**

  Inside `ensureInboxState`, find the `JazzInboxState.create(...)` call. Update it to include the new lists:
  ```ts
  const inboxState = JazzInboxState.create(
    {
      mailboxes: [],
      folders: [],
      messages: [],
      senderRules: [],
      scheduledEmails: [],
      lastSyncedAt: new Date().toISOString(),
    },
    { owner },
  );
  ```

  After the `if (me.root.inboxState) { return me.root.inboxState; }` early-return path, add initialization for existing users who already have an `inboxState` but lack the new lists:
  ```ts
  const existingState = me.root.inboxState;
  if (existingState) {
    // Initialize missing lists for users who had inboxState before this feature
    if (!existingState.$jazz.has("senderRules")) {
      existingState.$jazz.set(
        "senderRules",
        // Mirror the pattern from withMigration: create a new CoList using the Jazz API
        // jazz-tools v0.20: co.list(JazzSenderRule).create([], { owner })
        (JazzSenderRule as any).createList([], { owner }),
      );
    }
    if (!existingState.$jazz.has("scheduledEmails")) {
      existingState.$jazz.set(
        "scheduledEmails",
        (JazzScheduledEmail as any).createList([], { owner }),
      );
    }
    return existingState;
  }
  ```

  > **Note:** The Jazz-Tools v0.20 API for creating a new CoList from a CoMap schema may differ from the above. If `createList` is not available, consult the Jazz-Tools source or docs for the equivalent. The key constraint is that you must pass a Jazz CoList instance (not a plain `[]`) when calling `$jazz.set()` on a CoMap field.

- [ ] **Step 4: Change `syncInbox` from replace to append-merge**

  The current implementation calls `state.messages.$jazz.applyDiff(payload.messages.map(...))` which replaces the full list. Replace with merge logic:

  ```ts
  const syncInbox = (payload: {
    messages: EmailDto[];
    folders: FolderDto[];
    mailboxes: MailboxDto[];
  }) => {
    const state = ensureInboxState();
    const isInitialSync = state.messages.length === 0;

    // Build map of existing messages by key
    const existingMessages = new Map(
      state.messages.map((m: any) => [
        `${m.mailboxAddress}:${m.uid}`,
        m,
      ]),
    );

    // Merge: start with all existing, add/update from payload
    const merged = new Map(existingMessages);
    for (const message of payload.messages) {
      const key = `${message.mailboxAddress}:${message.uid}`;
      const existing = existingMessages.get(key);
      const isNew = isInitialSync
        ? false
        : message.isNew ?? existing?.isNew ?? !existing;
      merged.set(key, {
        id: message.id,
        uid: message.uid,
        mailboxAddress: message.mailboxAddress,
        subject: message.subject,
        fromName: message.from[0] ?? "Unknown",
        fromAddress: message.from[1] ?? "unknown",
        to: message.to,
        body: message.body,
        date: message.date,
        isRead: message.isRead,
        isNew,
        // Preserve Jazz-only fields from existing entry so a re-fetch doesn't
        // reset snooze or archive state for messages already in the cache.
        ...(existing?.snoozedUntil !== undefined && { snoozedUntil: existing.snoozedUntil }),
        ...(existing?.isArchived !== undefined && { isArchived: existing.isArchived }),
      });
    }

    state.messages.$jazz.applyDiff([...merged.values()]);

    // Folders and mailboxes: replace as before
    state.folders.$jazz.applyDiff(
      payload.folders.map((f) => ({
        id: f.id,
        name: f.name,
        path: f.path,
        unread: f.unread,
        total: f.total,
      })),
    );

    state.mailboxes.$jazz.applyDiff(
      payload.mailboxes.map((m) => ({
        id: m.id,
        emailAddress: m.emailAddress,
        image: m.image ?? undefined,
      })),
    );

    state.$jazz.set("lastSyncedAt", new Date().toISOString());
  };
  ```

- [ ] **Step 5: Update `mapMessages` to include new fields**

  ```ts
  const mapMessages = (state: any): EmailDto[] =>
    state.messages.map((m: any) => ({
      id: m.id,
      uid: m.uid,
      mailboxAddress: m.mailboxAddress,
      subject: m.subject,
      from: [m.fromName, m.fromAddress],
      to: m.to,
      body: m.body,
      date: m.date,
      isRead: m.isRead,
      isNew: m.isNew ?? false,
      snoozedUntil: m.snoozedUntil,
      isArchived: m.isArchived ?? false,
    }));
  ```

- [ ] **Step 6: Add new actions inside the `useMemo`**

  After the existing `updateMessageReadStatus` and `clearMessageNewStatus` definitions:

  ```ts
  const archiveMessage = (target: Pick<EmailDto, "uid" | "mailboxAddress">) => {
    const state = ensureInboxState();
    const msg = state.messages.find(
      (m: any) => m.uid === target.uid && m.mailboxAddress === target.mailboxAddress,
    );
    if (msg) msg.$jazz.set("isArchived", true);
  };

  const snoozeMessage = (
    target: Pick<EmailDto, "uid" | "mailboxAddress">,
    until: string | undefined,
  ) => {
    const state = ensureInboxState();
    const msg = state.messages.find(
      (m: any) => m.uid === target.uid && m.mailboxAddress === target.mailboxAddress,
    );
    if (msg) {
      if (until) {
        msg.$jazz.set("snoozedUntil", until);
        msg.$jazz.set("isNew", false);
      } else {
        // Resurface: clear snooze and mark as new
        msg.$jazz.set("snoozedUntil", undefined);
        msg.$jazz.set("isNew", true);
      }
    }
  };

  const allowSender = (address: string) => {
    const state = ensureInboxState();
    const rules = state.senderRules ?? [];
    const existing = rules.find((r: any) => r.address === address);
    if (existing) {
      existing.$jazz.set("rule", "allow");
    } else {
      rules.$jazz.applyDiff([
        ...rules.map((r: any) => ({ address: r.address, rule: r.rule })),
        { address, rule: "allow" },
      ]);
    }
  };

  const blockSender = (address: string) => {
    const state = ensureInboxState();
    const rules = state.senderRules ?? [];
    const existing = rules.find((r: any) => r.address === address);
    if (existing) {
      existing.$jazz.set("rule", "block");
    } else {
      rules.$jazz.applyDiff([
        ...rules.map((r: any) => ({ address: r.address, rule: r.rule })),
        { address, rule: "block" },
      ]);
    }
  };

  const syncScheduledEmails = (
    emails: Array<{ id: string; to: string; subject: string; sendAt: string }>,
  ) => {
    const state = ensureInboxState();
    state.scheduledEmails?.$jazz.applyDiff(emails);
  };
  ```

- [ ] **Step 7: Return new fields from context**

  ```ts
  return {
    messages: mapMessages(state),
    folders: mapFolders(state),
    mailboxes: mapMailboxes(state),
    scheduledEmails: (state.scheduledEmails ?? []).map((e: any) => ({
      id: e.id, to: e.to, subject: e.subject, sendAt: e.sendAt,
    })),
    senderRules: (state.senderRules ?? []).map((r: any) => ({
      address: r.address, rule: r.rule as "allow" | "block",
    })),
    syncInbox,
    updateMessageReadStatus,
    clearMessageNewStatus,
    archiveMessage,
    snoozeMessage,
    allowSender,
    blockSender,
    syncScheduledEmails,
  };
  ```

- [ ] **Step 8: Verify the build compiles**

  ```bash
  cd web/xedmail && npm run build 2>&1 | head -60
  ```

- [ ] **Step 9: Commit**

  ```bash
  git add web/xedmail/src/providers/jazz-provider.tsx
  git commit -m "feat: update Jazz provider with new actions, append-merge, and new list fields"
  ```

---

## Task 12: Inbox Page — UID Watermark Polling + Hybrid Search

**Files:**
- Modify: `web/xedmail/src/app/inbox/page.tsx`

- [ ] **Step 1: Pull new values and actions from Jazz context**

  ```ts
  const {
    messages, folders, mailboxes, syncInbox,
    scheduledEmails, syncScheduledEmails, snoozeMessage,
  } = useJazzInboxState();
  ```

- [ ] **Step 2: Add `resurfaceSnoozedMessages` helper**

  ```ts
  const resurfaceSnoozedMessages = React.useCallback(() => {
    const now = new Date();
    for (const msg of messages) {
      if (msg.snoozedUntil && new Date(msg.snoozedUntil) <= now) {
        snoozeMessage({ uid: msg.uid, mailboxAddress: msg.mailboxAddress }, undefined);
      }
    }
  }, [messages, snoozeMessage]);
  ```

- [ ] **Step 3: Add local hybrid search computation**

  ```ts
  const localSearchResults = React.useMemo(() => {
    if (!query) return messages;
    const q = query.toLowerCase();
    return messages.filter(
      (m) =>
        m.subject.toLowerCase().includes(q) ||
        (m.from[0] ?? "").toLowerCase().includes(q) ||
        (m.from[1] ?? "").toLowerCase().includes(q),
    );
  }, [messages, query]);
  ```

- [ ] **Step 4: Replace `getAllEmails` with UID-watermark logic**

  Replace the existing `getAllEmails` callback entirely:

  ```ts
  const getAllEmails = React.useCallback(async (includeFolders: boolean) => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    const requestId = ++requestIdRef.current;
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    const isInitialLoad = messages.length === 0;
    if (isInitialLoad) setIsLoading(true);

    try {
      const token = await getToken();

      if (isInitialLoad) {
        // Initial full fetch
        const response = await fetch(
          `/api/mail/search?query=&includeFolders=${includeFolders}`,
          { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: abortController.signal },
        );
        if (!response.ok || requestIdRef.current !== requestId) return;
        const payload = await response.json();
        syncInbox({
          messages: payload.emails ?? [],
          folders: payload.folders ?? (includeFolders ? [] : foldersRef.current),
          mailboxes: mailboxesRef.current,
        });
        if (includeFolders) hasFetchedFoldersRef.current = true;
      } else {
        // Incremental: only fetch UIDs above watermark per mailbox
        const uniqueMailboxes = [...new Set(messages.map((m) => m.mailboxAddress))];
        for (const mailboxAddress of uniqueMailboxes) {
          if (requestIdRef.current !== requestId) break;
          const maxUid = Math.max(
            0,
            ...messages
              .filter((m) => m.mailboxAddress === mailboxAddress)
              .map((m) => parseInt(m.uid, 10))
              .filter((n) => !Number.isNaN(n)),
          );
          const response = await fetch(
            `/api/mail/new?minUid=${maxUid}&mailbox=${encodeURIComponent(mailboxAddress)}`,
            { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: abortController.signal },
          );
          if (!response.ok || requestIdRef.current !== requestId) continue;
          const payload = await response.json();
          if ((payload.emails ?? []).length > 0) {
            syncInbox({ messages: payload.emails, folders: [], mailboxes: mailboxesRef.current });
          }
        }
      }

      // Hybrid search: fall back to server if local results are sparse
      if (query && localSearchResults.length < 5 && requestIdRef.current === requestId) {
        const response = await fetch(
          `/api/mail/search?query=${encodeURIComponent(query)}&includeFolders=false`,
          { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: abortController.signal },
        );
        if (response.ok && requestIdRef.current === requestId) {
          const payload = await response.json();
          if ((payload.emails ?? []).length > 0) {
            syncInbox({ messages: payload.emails, folders: [], mailboxes: mailboxesRef.current });
          }
        }
      }

      // Resurface snoozed emails
      resurfaceSnoozedMessages();

      // Sync scheduled emails
      if (requestIdRef.current === requestId) {
        const scheduledResponse = await fetch("/api/mail/scheduled", {
          headers: { Authorization: `Bearer ${token}` },
          signal: abortController.signal,
        });
        if (scheduledResponse.ok && requestIdRef.current === requestId) {
          const { scheduled } = await scheduledResponse.json();
          syncScheduledEmails(scheduled ?? []);
        }
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
    } finally {
      if (requestIdRef.current === requestId) {
        isFetchingRef.current = false;
        setIsLoading(false);
      }
    }
  }, [getToken, query, messages, localSearchResults, syncInbox, syncScheduledEmails, resurfaceSnoozedMessages]);
  ```

- [ ] **Step 5: Pass `localSearchResults` to `InboxClient`**

  ```ts
  return <InboxClient emails={localSearchResults} isLoading={isLoading} query={query} />;
  ```

- [ ] **Step 6: Verify in browser**

  Load the inbox. Emails should appear. Wait 30 seconds — no full re-fetch spinner, only new emails appear. Type a search query — local results appear instantly; if < 5, also waits briefly for server results.

- [ ] **Step 7: Commit**

  ```bash
  git add web/xedmail/src/app/inbox/page.tsx
  git commit -m "feat: UID watermark polling, hybrid search, snooze resurface in inbox page"
  ```

---

## Task 13: Inbox Client — Archive, Snooze, Inbox Filters

**Files:**
- Modify: `web/xedmail/src/components/inbox/inbox-client.tsx`

- [ ] **Step 1: Extend the local `Email` interface**

  ```ts
  interface Email {
    id: string; uid: string; mailboxAddress: string; subject: string;
    from: [string, string]; to: string; body?: string; date: string;
    isRead: boolean; isNew?: boolean;
    snoozedUntil?: string;   // new
    isArchived?: boolean;    // new
  }
  ```

- [ ] **Step 2: Pull new Jazz actions**

  ```ts
  const { archiveMessage, snoozeMessage, senderRules } = useJazzInboxState();
  ```

- [ ] **Step 3: Apply inbox filters in `filteredEmails`**

  ```ts
  const blockedAddresses = React.useMemo(
    () => new Set(senderRules.filter((r) => r.rule === "block").map((r) => r.address)),
    [senderRules],
  );

  const filteredEmails = useMemo(() => {
    const now = new Date();
    let result = sortedEmails.filter((e) => {
      if (e.isArchived) return false;
      if (e.snoozedUntil && new Date(e.snoozedUntil) > now) return false;
      if (blockedAddresses.has(e.from[1])) return false;
      return true;
    });
    if (activeTab === "Unread") result = result.filter((e) => !e.isRead);
    return result;
  }, [sortedEmails, activeTab, blockedAddresses]);
  ```

- [ ] **Step 4: Add `handleArchive`**

  ```ts
  const handleArchive = React.useCallback(async () => {
    if (!selectedEmail) return;
    const token = await getToken();
    const response = await fetch(
      `/api/mail/emails/mailbox/${encodeURIComponent(selectedEmail.mailboxAddress)}/${selectedEmail.uid}/archive`,
      { method: "POST", headers: { Authorization: `Bearer ${token}` } },
    );
    if (response.ok) {
      archiveMessage({ uid: selectedEmail.uid, mailboxAddress: selectedEmail.mailboxAddress });
      closeReader();
    }
  }, [selectedEmail, getToken, archiveMessage, closeReader]);
  ```

- [ ] **Step 5: Add snooze state and helpers**

  ```ts
  const [isSnoozeOpen, setIsSnoozeOpen] = useState(false);

  function getSnoozeDate(preset: "today" | "tomorrow" | "nextWeek"): Date {
    const d = new Date();
    if (preset === "today") { d.setHours(d.getHours() + 3); return d; }
    if (preset === "tomorrow") { d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d; }
    const day = d.getDay();
    const daysUntilMonday = day === 0 ? 1 : 8 - day;
    d.setDate(d.getDate() + daysUntilMonday);
    d.setHours(9, 0, 0, 0);
    return d;
  }

  const handleSnooze = (until: Date) => {
    if (!selectedEmail) return;
    snoozeMessage(
      { uid: selectedEmail.uid, mailboxAddress: selectedEmail.mailboxAddress },
      until.toISOString(),
    );
    setIsSnoozeOpen(false);
    closeReader();
  };
  ```

- [ ] **Step 6: Replace the three floating nav `<a>` tags with wired `<button>` elements**

  Replace the entire `{[{ icon: "archive" }, { icon: "schedule" }, { icon: "reply" }].map(...)}` block with explicit buttons:

  ```tsx
  {/* Archive */}
  <button
    type="button"
    onClick={handleArchive}
    disabled={!selectedEmail}
    className="flex flex-col items-center justify-center transition-all"
    style={{
      padding: "8px 16px", borderRadius: "0.75rem",
      color: selectedEmail ? "rgba(229,226,225,0.7)" : "rgba(229,226,225,0.3)",
      cursor: selectedEmail ? "pointer" : "not-allowed",
    }}
    onMouseEnter={(e) => { if (selectedEmail) { e.currentTarget.style.background = "#353535"; e.currentTarget.style.color = "#E5E2E1"; } }}
    onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = selectedEmail ? "rgba(229,226,225,0.7)" : "rgba(229,226,225,0.3)"; }}
  >
    <span className="material-symbols-outlined" style={{ fontSize: 20, marginBottom: 4 }}>archive</span>
    <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, letterSpacing: "0.05em", textTransform: "uppercase" }}>Archive</span>
  </button>

  {/* Snooze */}
  <div className="relative">
    <button
      type="button"
      onClick={() => selectedEmail && setIsSnoozeOpen((o) => !o)}
      disabled={!selectedEmail}
      className="flex flex-col items-center justify-center transition-all"
      style={{
        padding: "8px 16px", borderRadius: "0.75rem",
        color: selectedEmail ? "rgba(229,226,225,0.7)" : "rgba(229,226,225,0.3)",
        cursor: selectedEmail ? "pointer" : "not-allowed",
      }}
      onMouseEnter={(e) => { if (selectedEmail) { e.currentTarget.style.background = "#353535"; e.currentTarget.style.color = "#E5E2E1"; } }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = selectedEmail ? "rgba(229,226,225,0.7)" : "rgba(229,226,225,0.3)"; }}
    >
      <span className="material-symbols-outlined" style={{ fontSize: 20, marginBottom: 4 }}>schedule</span>
      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, letterSpacing: "0.05em", textTransform: "uppercase" }}>Snooze</span>
    </button>

    {isSnoozeOpen && (
      <div
        className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2"
        style={{ background: "#1C1B1B", border: "1px solid rgba(82,68,57,0.3)", borderRadius: "0.75rem", padding: 12, minWidth: 176, zIndex: 60 }}
      >
        {([
          { label: "Later today", fn: () => handleSnooze(getSnoozeDate("today")) },
          { label: "Tomorrow", fn: () => handleSnooze(getSnoozeDate("tomorrow")) },
          { label: "Next week", fn: () => handleSnooze(getSnoozeDate("nextWeek")) },
        ] as const).map(({ label, fn }) => (
          <button
            key={label} type="button" onClick={fn}
            className="block w-full text-left transition-opacity hover:opacity-70"
            style={{ padding: "6px 8px", fontSize: 12, color: "#E5E2E1", borderRadius: "0.5rem" }}
          >
            {label}
          </button>
        ))}
        {/* Custom date/time picker */}
        <div style={{ borderTop: "1px solid rgba(82,68,57,0.2)", marginTop: 8, paddingTop: 8 }}>
          <label style={{ fontSize: 10, color: "#D8C3B4", fontFamily: "'JetBrains Mono', monospace", textTransform: "uppercase", letterSpacing: "0.05em", display: "block", marginBottom: 4 }}>
            Custom
          </label>
          <input
            type="datetime-local"
            min={new Date().toISOString().slice(0, 16)}
            onChange={(e) => {
              if (e.target.value) handleSnooze(new Date(e.target.value));
            }}
            style={{ background: "#131313", border: "1px solid rgba(82,68,57,0.3)", borderRadius: "0.5rem", padding: "4px 8px", fontSize: 11, color: "#E5E2E1", width: "100%", outline: "none" }}
          />
        </div>
      </div>
    )}
  </div>

  {/* Reply — wired in Task 14 */}
  <button
    type="button"
    onClick={openReply}
    disabled={!selectedEmail}
    className="flex flex-col items-center justify-center transition-all"
    style={{
      padding: "8px 16px", borderRadius: "0.75rem",
      color: selectedEmail ? "rgba(229,226,225,0.7)" : "rgba(229,226,225,0.3)",
      cursor: selectedEmail ? "pointer" : "not-allowed",
    }}
    onMouseEnter={(e) => { if (selectedEmail) { e.currentTarget.style.background = "#353535"; e.currentTarget.style.color = "#E5E2E1"; } }}
    onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = selectedEmail ? "rgba(229,226,225,0.7)" : "rgba(229,226,225,0.3)"; }}
  >
    <span className="material-symbols-outlined" style={{ fontSize: 20, marginBottom: 4 }}>reply</span>
    <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, letterSpacing: "0.05em", textTransform: "uppercase" }}>Reply</span>
  </button>
  ```

  > `openReply` is defined in Task 14. Declare it before use (forward-reference via `useCallback`).

- [ ] **Step 7: Verify in browser**

  Open an email → Archive button active. Click Archive → email disappears, reader closes. Click Snooze → popover with 3 presets + custom datetime input. Select "Later today" → email disappears. Check custom input fires `handleSnooze` on change.

- [ ] **Step 8: Commit**

  ```bash
  git add web/xedmail/src/components/inbox/inbox-client.tsx
  git commit -m "feat: wire Archive, Snooze popover with custom input, and inbox filters"
  ```

---

## Task 14: Inbox Client — Compose Modal (Reply + Send Later)

**Files:**
- Modify: `web/xedmail/src/components/inbox/inbox-client.tsx`

- [ ] **Step 1: Add compose state**

  ```ts
  const [isComposeOpen, setIsComposeOpen] = useState(false);
  const [composeTo, setComposeTo] = useState("");
  const [composeSubject, setComposeSubject] = useState("");
  const [composeBody, setComposeBody] = useState("");
  const [composeError, setComposeError] = useState<string | null>(null);
  const [composeReplyTo, setComposeReplyTo] = useState<string | undefined>();
  const [composeSending, setComposeSending] = useState(false);
  const [isSendLaterOpen, setIsSendLaterOpen] = useState(false);
  ```

- [ ] **Step 2: Add `openReply`**

  Note: `body` is the existing email-reader body state variable already declared in this component (`const [body, setBody] = useState("")`). It is in scope here because `openReply` is defined inside the same component function.

  ```ts
  const openReply = React.useCallback(() => {
    if (!selectedEmail) return;
    setComposeTo(selectedEmail.from[1]);
    const subject = selectedEmail.subject.startsWith("Re:")
      ? selectedEmail.subject
      : `Re: ${selectedEmail.subject}`;
    setComposeSubject(subject);
    setComposeBody(`\n\n---\n${body}`); // body = current reader body state
    setComposeReplyTo(selectedEmail.id);
    setComposeError(null);
    setIsComposeOpen(true);
  }, [selectedEmail, body]);
  ```

- [ ] **Step 3: Add `handleSend`**

  ```ts
  const handleSend = async () => {
    if (!selectedEmail) return;
    setComposeSending(true);
    setComposeError(null);
    try {
      const token = await getToken();
      const res = await fetch("/api/mail/emails/send", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          mailbox: selectedEmail.mailboxAddress,
          to: composeTo, subject: composeSubject, body: composeBody,
          inReplyTo: composeReplyTo, references: composeReplyTo,
        }),
      });
      const result = await res.json();
      if (result.error === "INSUFFICIENT_SCOPE") {
        setComposeError("Reconnect your mailbox in Settings to enable sending.");
      } else if (result.error) {
        setComposeError(result.error);
      } else {
        setIsComposeOpen(false);
      }
    } catch {
      setComposeError("Network error. Please try again.");
    } finally {
      setComposeSending(false);
    }
  };
  ```

- [ ] **Step 4: Add `handleScheduleSend`**

  ```ts
  const handleScheduleSend = async (sendAt: Date) => {
    if (!selectedEmail) return;
    setComposeSending(true);
    setComposeError(null);
    try {
      const token = await getToken();
      const res = await fetch("/api/mail/emails/schedule", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          mailbox: selectedEmail.mailboxAddress,
          to: composeTo, subject: composeSubject, body: composeBody,
          inReplyTo: composeReplyTo, references: composeReplyTo,
          sendAt: sendAt.toISOString(),
        }),
      });
      const result = await res.json();
      if (result.error) {
        setComposeError(result.error);
      } else {
        setIsComposeOpen(false);
        setIsSendLaterOpen(false);
      }
    } catch {
      setComposeError("Network error. Please try again.");
    } finally {
      setComposeSending(false);
    }
  };
  ```

- [ ] **Step 5: Add the Compose modal overlay to the JSX**

  Add before the closing `</div>` of InboxClient:

  ```tsx
  {isComposeOpen && (
    <div className="fixed inset-0 z-50 flex flex-col overflow-hidden" style={{ background: "#131313", fontFamily: "'Inter', sans-serif" }}>
      <nav
        className="fixed top-0 left-0 w-full flex justify-between items-center px-6 py-3"
        style={{ background: "rgba(19,19,19,0.8)", backdropFilter: "blur(20px)", zIndex: 50 }}
      >
        <span style={{ fontFamily: "'Newsreader', serif", fontSize: 20, fontWeight: 500, color: "#E5E2E1" }}>New Message</span>
        <button
          type="button"
          onClick={() => {
            if (composeBody.trim() && !window.confirm("Discard this message?")) return;
            setIsComposeOpen(false);
          }}
          style={{ color: "#D8C3B4" }}
        >
          <span className="material-symbols-outlined">close</span>
        </button>
      </nav>

      <main style={{ maxWidth: 768, margin: "0 auto", width: "100%", padding: "96px 24px 24px" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <input
            type="email" placeholder="To" value={composeTo}
            onChange={(e) => setComposeTo(e.target.value)}
            style={{ background: "#1C1B1B", border: "1px solid rgba(82,68,57,0.3)", borderRadius: "0.5rem", padding: "10px 14px", color: "#E5E2E1", fontSize: 14, outline: "none" }}
          />
          <input
            type="text" placeholder="Subject" value={composeSubject}
            onChange={(e) => setComposeSubject(e.target.value)}
            style={{ background: "#1C1B1B", border: "1px solid rgba(82,68,57,0.3)", borderRadius: "0.5rem", padding: "10px 14px", color: "#E5E2E1", fontSize: 14, outline: "none" }}
          />
          <textarea
            placeholder="Write your message…" value={composeBody} rows={14}
            onChange={(e) => setComposeBody(e.target.value)}
            style={{ background: "#1C1B1B", border: "1px solid rgba(82,68,57,0.3)", borderRadius: "0.5rem", padding: "10px 14px", color: "#E5E2E1", fontSize: 14, outline: "none", resize: "vertical" }}
          />
          {composeError && <p style={{ fontSize: 12, color: "#FFB77B" }}>{composeError}</p>}
          <div className="flex gap-3 items-center">
            <button
              type="button" onClick={handleSend} disabled={composeSending}
              style={{ background: "linear-gradient(135deg, #FFB77B, #C8803F)", color: "#4D2700", padding: "10px 24px", borderRadius: "0.75rem", fontWeight: 600, fontSize: 13, opacity: composeSending ? 0.6 : 1 }}
            >
              {composeSending ? "Sending…" : "Send"}
            </button>
            <div className="relative">
              <button
                type="button" disabled={composeSending}
                onClick={() => setIsSendLaterOpen((o) => !o)}
                style={{ background: "#1C1B1B", border: "1px solid rgba(82,68,57,0.3)", color: "#D8C3B4", padding: "10px 16px", borderRadius: "0.75rem", fontSize: 13 }}
              >
                Send Later
              </button>
              {isSendLaterOpen && (
                <div style={{ position: "absolute", bottom: "calc(100% + 8px)", left: 0, background: "#1C1B1B", border: "1px solid rgba(82,68,57,0.3)", borderRadius: "0.75rem", padding: 12, minWidth: 176, zIndex: 60 }}>
                  {([
                    { label: "Later today", fn: () => handleScheduleSend(getSnoozeDate("today")) },
                    { label: "Tomorrow", fn: () => handleScheduleSend(getSnoozeDate("tomorrow")) },
                    { label: "Next week", fn: () => handleScheduleSend(getSnoozeDate("nextWeek")) },
                  ] as const).map(({ label, fn }) => (
                    <button key={label} type="button" onClick={fn} className="block w-full text-left hover:opacity-70"
                      style={{ padding: "6px 8px", fontSize: 12, color: "#E5E2E1", borderRadius: "0.5rem" }}>
                      {label}
                    </button>
                  ))}
                  <div style={{ borderTop: "1px solid rgba(82,68,57,0.2)", marginTop: 8, paddingTop: 8 }}>
                    <label style={{ fontSize: 10, color: "#D8C3B4", fontFamily: "'JetBrains Mono', monospace", textTransform: "uppercase", display: "block", marginBottom: 4 }}>Custom</label>
                    <input type="datetime-local" min={new Date().toISOString().slice(0, 16)}
                      onChange={(e) => { if (e.target.value) handleScheduleSend(new Date(e.target.value)); }}
                      style={{ background: "#131313", border: "1px solid rgba(82,68,57,0.3)", borderRadius: "0.5rem", padding: "4px 8px", fontSize: 11, color: "#E5E2E1", width: "100%", outline: "none" }}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  )}
  ```

- [ ] **Step 6: Verify in browser**

  Open an email, click Reply. Compose overlay opens with To/Subject/body pre-filled. Type a message, click Send. Modal closes (or shows INSUFFICIENT_SCOPE prompt). Click Send Later → time picker appears. Select "Tomorrow" → modal closes.

- [ ] **Step 7: Commit**

  ```bash
  git add web/xedmail/src/components/inbox/inbox-client.tsx
  git commit -m "feat: add compose modal with Reply and Send Later"
  ```

---

## Task 15: Inbox Client — Gatekeeper Real Data

**Files:**
- Modify: `web/xedmail/src/components/inbox/inbox-client.tsx`

- [ ] **Step 1: Delete the `GATEKEEPER_CARDS` constant**

  Remove the hardcoded `GATEKEEPER_CARDS` array near the top of the file.

- [ ] **Step 2: Pull `allowSender` and `blockSender` from context**

  ```ts
  const { allowSender, blockSender } = useJazzInboxState();
  ```

- [ ] **Step 3: Compute gatekeeper candidates**

  Add to the component body (uses `sortedEmails` which is already computed):

  ```ts
  const gatekeeperCandidates = useMemo(() => {
    const ruledAddresses = new Set(senderRules.map((r) => r.address));
    const addressCount = new Map<string, number>();
    for (const email of sortedEmails) {
      const addr = email.from[1];
      addressCount.set(addr, (addressCount.get(addr) ?? 0) + 1);
    }
    return sortedEmails
      .filter((e) => addressCount.get(e.from[1]) === 1 && !ruledAddresses.has(e.from[1]))
      .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
      .slice(0, 3);
  }, [sortedEmails, senderRules]);
  ```

- [ ] **Step 4: Replace the Gatekeeper section JSX**

  Replace the entire `<section>` that renders `GATEKEEPER_CARDS.map(...)` with:

  ```tsx
  {gatekeeperCandidates.length > 0 && (
    <section style={{ marginBottom: 48 }}>
      <div className="flex items-baseline gap-3 mb-6">
        <h2 style={{ fontFamily: "'Newsreader', serif", fontSize: 30, color: "#E5E2E1" }}>The Gatekeeper</h2>
        <span style={{ fontFamily: "'Newsreader', serif", fontStyle: "italic", fontSize: 18, color: "#D8C3B4" }}>
          Reviewing {gatekeeperCandidates.length} first-time sender{gatekeeperCandidates.length !== 1 ? "s" : ""}
        </span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {gatekeeperCandidates.map((email) => (
          <div
            key={`${email.mailboxAddress}:${email.uid}`}
            className="group flex flex-col gap-3 transition-all"
            style={{ background: "#1C1B1B", border: "1px solid rgba(82,68,57,0.15)", padding: 16, borderRadius: "0.75rem" }}
          >
            <div className="flex items-center gap-3">
              <div
                className="flex items-center justify-center"
                style={{ width: 32, height: 32, borderRadius: "9999px", background: "rgba(82,68,57,0.3)", color: "rgba(255,183,123,0.8)", fontSize: 14, fontWeight: 700 }}
              >
                {(email.from[0]?.[0] ?? email.from[1]?.[0] ?? "?").toUpperCase()}
              </div>
              <div className="flex flex-col">
                <h3 style={{ fontSize: 14, fontWeight: 500, color: "#E5E2E1" }}>{email.from[0] || email.from[1]}</h3>
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 8, color: "rgba(216,195,180,0.4)", letterSpacing: "0.1em", textTransform: "uppercase" }}>{email.from[1]}</span>
              </div>
            </div>
            <p style={{ fontSize: 12, color: "rgba(216,195,180,0.7)", lineHeight: 1.6, minHeight: "3rem" }}>{email.subject}</p>
            <div className="flex gap-4 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <button type="button" onClick={() => allowSender(email.from[1])} className="hover:underline"
                style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "#FFB77B" }}>
                Allow
              </button>
              <button type="button" onClick={() => blockSender(email.from[1])} className="hover:opacity-70"
                style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "rgba(216,195,180,0.6)" }}>
                Block
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  )}
  ```

- [ ] **Step 5: Verify in browser**

  Gatekeeper section appears only with real first-time senders from the Jazz cache. Clicking Allow removes the sender from Gatekeeper and their emails appear normally. Clicking Block hides all their emails everywhere.

- [ ] **Step 6: Commit**

  ```bash
  git add web/xedmail/src/components/inbox/inbox-client.tsx
  git commit -m "feat: Gatekeeper shows real first-time senders with Allow/Block"
  ```

---

## Task 16: Inbox Client — Settings Button, Prev/Next Navigation

**Files:**
- Modify: `web/xedmail/src/components/inbox/inbox-client.tsx`

- [ ] **Step 1: Wire the Settings button**

  Find the existing `<button>` with the `settings` material icon in the header. Add an `onClick`:
  ```tsx
  <button
    type="button"
    onClick={() => router.push("/settings")}
    className="p-2 transition-colors"
    style={{ color: "#D8C3B4", borderRadius: "0.5rem" }}
    onMouseEnter={(e) => (e.currentTarget.style.color = "#FFB77B")}
    onMouseLeave={(e) => (e.currentTarget.style.color = "#D8C3B4")}
  >
    <span className="material-symbols-outlined" style={{ fontSize: 20 }}>settings</span>
  </button>
  ```
  (`router` is already declared via `useRouter()`.)

  Do the same for the Settings button inside `EmailReader`'s nav (same pattern).

- [ ] **Step 2: Track selected email index**

  Add state:
  ```ts
  const [selectedEmailIndex, setSelectedEmailIndex] = useState<number>(-1);
  ```

- [ ] **Step 3: Update `openEmail` to record the index**

  ```ts
  const openEmail = async (email: Email, index?: number) => {
    setSelectedEmail({ ...email, isNew: false });
    setSelectedEmailIndex(
      index ?? filteredEmails.findIndex((e) => getEmailKey(e) === getEmailKey(email)),
    );
    setBody("");
    setIsReaderOpen(true);
    clearMessageNewStatus({ uid: email.uid, mailboxAddress: email.mailboxAddress });
    await fetchBody(email);
  };
  ```

- [ ] **Step 4: Pass index in the email list render**

  Update the `filteredEmails.map(...)` to pass the index:
  ```tsx
  {filteredEmails.map((email, index) => (
    <li key={getEmailKey(email)} onClick={() => openEmail(email, index)} ...>
  ```

- [ ] **Step 5: Add `emails` and `emailIndex` props to `EmailReader`**

  Update `EmailReader`'s prop interface:
  ```ts
  function EmailReader({
    email, body, onClose, onToggleRead,
    emails, emailIndex, onNavigate,
  }: {
    email: Email;
    body: string;
    onClose: () => void;
    onToggleRead: (email: Email) => Promise<void>;
    emails: Email[];
    emailIndex: number;
    onNavigate: (email: Email, index: number) => Promise<void>;
  })
  ```

- [ ] **Step 6: Wire Prev/Next in `EmailReader` JSX**

  Replace the existing `onClick={onClose}` handlers on the header navigation items:

  ```tsx
  {/* Previous */}
  <div
    className={emailIndex > 0 ? "group cursor-pointer" : "opacity-30 cursor-default"}
    onClick={() => { if (emailIndex > 0) onNavigate(emails[emailIndex - 1], emailIndex - 1); }}
  >
    <p style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, letterSpacing: "0.15em", textTransform: "uppercase", color: "#D8C3B4", marginBottom: 8 }}>
      Previous Message
    </p>
    <div className="flex items-center gap-3" style={{ color: emailIndex > 0 ? "rgba(229,226,225,0.4)" : "rgba(229,226,225,0.15)" }}>
      <span className="material-symbols-outlined" style={{ fontSize: 18 }}>arrow_back</span>
      <span style={{ fontFamily: "'Newsreader', serif", fontStyle: "italic", fontSize: 18 }}>
        {emailIndex > 0 ? (emails[emailIndex - 1].from[0] || emails[emailIndex - 1].subject) : "—"}
      </span>
    </div>
  </div>

  {/* Next */}
  <div
    className={emailIndex < emails.length - 1 ? "cursor-pointer text-right" : "opacity-30 cursor-default text-right"}
    onClick={() => { if (emailIndex < emails.length - 1) onNavigate(emails[emailIndex + 1], emailIndex + 1); }}
  >
    <p style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, letterSpacing: "0.15em", textTransform: "uppercase", color: "#D8C3B4", marginBottom: 8 }}>
      Upcoming Message
    </p>
    <div className="flex items-center gap-3 justify-end" style={{ color: emailIndex < emails.length - 1 ? "rgba(229,226,225,0.4)" : "rgba(229,226,225,0.15)" }}>
      <span style={{ fontFamily: "'Newsreader', serif", fontStyle: "italic", fontSize: 18 }}>
        {emailIndex < emails.length - 1 ? (emails[emailIndex + 1].from[0] || emails[emailIndex + 1].subject) : "—"}
      </span>
      <span className="material-symbols-outlined" style={{ fontSize: 18 }}>arrow_forward</span>
    </div>
  </div>
  ```

- [ ] **Step 7: Update `EmailReader` usage in `InboxClient`**

  ```tsx
  <EmailReader
    email={selectedEmail}
    body={body}
    onClose={closeReader}
    onToggleRead={toggleRead}
    emails={filteredEmails}
    emailIndex={selectedEmailIndex}
    onNavigate={openEmail}
  />
  ```

- [ ] **Step 8: Run lint**

  ```bash
  cd web/xedmail && npm run lint
  ```
  Fix any Biome warnings.

- [ ] **Step 9: Verify in browser**

  Open an email. Previous/Next areas show adjacent email sender names. Click Next → opens next email (body loads). At first email, Previous area is dimmed and unclickable. Settings icon navigates to `/settings`.

- [ ] **Step 10: Commit**

  ```bash
  git add web/xedmail/src/components/inbox/inbox-client.tsx
  git commit -m "feat: wire Settings button and Prev/Next email navigation"
  ```

---

## Done

All tasks complete. The inbox now:
- Loads from Jazz cache immediately, polling only for new UIDs above the watermark
- Searches Jazz locally first, falls back to IMAP for sparse results
- Archives emails via IMAP with Jazz reflecting the change instantly
- Snoozes emails in Jazz with custom date/time input and automatic resurface on poll
- Composes and sends emails via Gmail REST API, with scheduled send backed by Turso + Vercel Cron (atomic claim with TTL crash recovery)
- Shows real first-time senders in the Gatekeeper with Allow/Block wired to Jazz
- Navigates between emails with Prev/Next buttons showing adjacent sender names
- Settings button routes to `/settings`
