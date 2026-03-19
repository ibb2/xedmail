# Design: Jazz-first Email Cache & UI Wiring

**Date:** 2026-03-20
**Status:** Approved

---

## Overview

Two related goals:

1. **Jazz-first data flow** — stop hitting IMAP on every search/poll. Use Jazz as the source of truth; only fetch new messages from IMAP (UID watermark strategy for new inbox arrivals).
2. **Wire up all UI elements** — Archive, Snooze, Reply (with scheduled send), Gatekeeper, Settings navigation, and Prev/Next email navigation.

---

## 1. Jazz Schema Changes

### `JazzMessage` — two new optional fields added
- `snoozedUntil: z.optional(z.string())` — ISO date string; hides email from inbox until this time passes
- `isArchived: z.optional(z.boolean())` — set client-side after successful IMAP archive

Existing field `isNew: z.optional(z.boolean())` already in schema; reused for snooze resurface.

### `JazzMailbox` — no new fields
`lastKnownUid` is **not** stored. Derived at fetch time: `max(parseInt(uid))` across all Jazz messages per `mailboxAddress`. Avoids stored/derived divergence.

### New `JazzSenderRule` CoMap
```ts
co.map({ address: z.string(), rule: z.enum(["allow", "block"]) })
```

### New `JazzScheduledEmail` CoMap
```ts
co.map({ id: z.string(), to: z.string(), subject: z.string(), sendAt: z.string() })
```
Client-side display only. Jazz `scheduledEmails` list is **replaced wholesale** on each poll from `GET /api/mail/scheduled` — this eliminates stale entries when the cron marks emails as sent.

### `JazzInboxState` — two new fields
- `senderRules: co.list(JazzSenderRule)`
- `scheduledEmails: co.list(JazzScheduledEmail)`

### `resolved` map update
`JazzMailAccount.resolved(...)` must be updated to include the two new lists:
```ts
{
  root: {
    inboxState: {
      mailboxes: { $each: true },
      folders: { $each: true },
      messages: { $each: true },
      senderRules: { $each: true },       // new
      scheduledEmails: { $each: true },   // new
    },
  },
}
```
Without this, Jazz will not eagerly load the new lists and reads will return `undefined`.

### Initialization of new fields
**Do not use `withMigration`** for the new list fields. Instead, initialize them inside `ensureInboxState()` in `jazz-provider.tsx` — the function that already handles creating `JazzInboxState` on first use. When creating a new `JazzInboxState`, include `senderRules: []` and `scheduledEmails: []` in the create call. For existing users whose `inboxState` already exists but lacks these fields, check and initialize them inside `ensureInboxState()` before returning (following the same `$jazz.has()` pattern used in the existing `withMigration` code).

---

## 2. Incremental Sync (Jazz-first Data Flow)

### Current flow (replaced)
Every 30s poll → IMAP full fetch → replace all Jazz messages → render

### New flow

**Initial load (Jazz empty):**
1. Render immediately from Jazz (empty state, no spinner)
2. Hit `/api/mail/search` (no query, limit 50) — existing route
3. Store results via `syncInbox` (append-merge, not replace — see provider changes)

**Subsequent polls (Jazz has data):**
1. Render from Jazz immediately — no loading spinner on poll
2. Derive `maxUid` per mailbox: `max(parseInt(msg.uid))` over all Jazz messages for that `mailboxAddress`; default to `0` if no messages
3. Hit `GET /api/mail/new?minUid=<maxUid>&mailbox=<addr>` per mailbox
4. Append-merge returned emails into Jazz (dedup by `mailboxAddress:uid`)

**UID watermark note:** Gmail assigns sequential UIDs to new messages arriving in INBOX. Using `maxUid` as a watermark is reliable for polling new incoming mail. Re-imported or moved messages may be missed; this is an acceptable trade-off for inbox polling.

**Snooze resurface:** on each poll, scan Jazz messages where `snoozedUntil` is set and `new Date(snoozedUntil) <= new Date()`. For each: clear `snoozedUntil` (set to `undefined`), set `isNew = true`.

**Scheduled email sync:** on each poll, call `GET /api/mail/scheduled` and replace the Jazz `scheduledEmails` list wholesale with the response.

### New API route: `GET /api/mail/new`
- **Auth:** `requireClerkUserId()` + `getValidMailboxForUser(clerkUserId, mailbox)` — same as all existing routes
- **Runtime:** `nodejs`
- **Query params:** `minUid` (integer string), `mailbox` (email address, URL-decoded)
- **IMAP operation:** `withImapClient` → `getMailboxLock(INBOX)` → use `client.fetch(\`${minUid + 1}:*\`, { uid: true, envelope: true, flags: true, internalDate: true }, { uid: true })` as an async iterator (matches the pattern in existing `imap.ts` fetch calls). If the range returns no messages (empty mailbox or no new UIDs), the iterator simply yields nothing — no error. Cap at 50 by breaking after 50 iterations → release lock
- **Limit:** cap at 50 messages maximum
- **Response:** `200 { emails: EmailDto[] }` — empty array is the common case
- **Errors:** `401` unauthorized, `404` mailbox not found, `500` IMAP failure

---

## 3. Search (Hybrid)

1. Filter Jazz messages locally: `subject`, `fromName`, or `fromAddress` contains the query (case-insensitive)
2. If local results ≥ 5 → return immediately (sufficient for a useful result set without network latency)
3. If local results < 5 → also call `/api/mail/search?query=<q>` (existing route), merge with local results (dedup by `mailboxAddress:uid`), return combined set

### Inbox view filters (always applied, before and independent of search)
- `snoozedUntil` is set and `snoozedUntil > now` → hidden
- `isArchived === true` → hidden
- `fromAddress` matches an entry in `senderRules` with `rule = "block"` → hidden

---

## 4. Archive

**Scope:** Gmail only. Route must verify the mailbox host is `imap.gmail.com` and return `400 { error: "Unsupported provider" }` otherwise.

**New API route:** `POST /api/mail/emails/mailbox/[mailbox]/[uid]/archive`
- This is a **new file** at `src/app/api/mail/emails/mailbox/[mailbox]/[uid]/archive/route.ts`. The existing sibling file `[uid]/route.ts` (which handles `PATCH` for read status) is **not modified**.
- **Auth:** `requireClerkUserId()` + `getValidMailboxForUser(clerkUserId, decodeURIComponent(mailbox))`
- **Runtime:** `nodejs`
- **IMAP:** calls new `archiveEmail(auth, uid)` helper in `imap.ts`
- **Response:** `204` on success; `400` unsupported provider; `401` unauthorized; `404` mailbox not found; `500` IMAP failure

**New `archiveEmail` helper in `imap.ts`:**
```ts
export async function archiveEmail(auth: ImapAuth, uid: string): Promise<void> {
  await withImapClient(auth, async (client) => {
    const lock = await client.getMailboxLock(INBOX);
    try {
      await client.messageMove(uid, '[Gmail]/All Mail', { uid: true });
    } finally {
      lock.release();
    }
  });
}
```

**Client:**
- On `204`: set `isArchived = true` on Jazz message → instantly removed from view
- On error: show brief toast error
- Floating nav Archive button active only when email is open in reader; dimmed otherwise

---

## 5. Snooze

**UI:** Clicking Snooze opens a small popover with preset options:
- Later today (+3h from current time)
- Tomorrow (9am local time)
- Next week (next Monday 9am local time)
- Custom (date/time input)

**Storage:** sets `snoozedUntil` ISO string on the Jazz message. No backend call.

**Resurface:** on each 30s poll, scan Jazz messages where `snoozedUntil` is set and `new Date(snoozedUntil) <= new Date()`. For each: clear `snoozedUntil`, set `isNew = true`. Email reappears with new-mail highlight.

Floating nav Snooze button active only when email is open in reader; dimmed otherwise.

---

## 6. Reply & Compose (with Scheduled Send)

### OAuth scope

**Change in `src/lib/google-oauth.ts`:** locate the existing scope string and append `https://www.googleapis.com/auth/gmail.send`. Result:
```
"openid https://mail.google.com/ profile email https://www.googleapis.com/auth/gmail.send"
```
Note: `https://mail.google.com/` covers IMAP but the Gmail REST send endpoint requires `gmail.send` as an explicit additional scope.

**Re-auth for existing users:** existing authorized mailboxes lack `gmail.send`. The API returns `{ error: "INSUFFICIENT_SCOPE" }` on 403 from Google. The compose modal shows an inline "Reconnect your mailbox in Settings" message. The user re-runs the existing `/api/mail/oauth/start` flow, which now includes the new scope.

### RFC 2822 message construction (no external library)

Build the raw message as a plain string — no `nodemailer` or `mailcomposer` needed for plain-text-only sends:

```ts
function buildRfc2822(opts: {
  from: string; to: string; subject: string; body: string;
  inReplyTo?: string; references?: string;
}): string {
  const date = new Date().toUTCString();
  const headers = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    `Date: ${date}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    opts.inReplyTo ? `In-Reply-To: ${opts.inReplyTo}` : null,
    opts.references  ? `References: ${opts.references}`  : null,
  ].filter(Boolean).join('\r\n');
  return `${headers}\r\n\r\n${opts.body}`;
}

function encodeMessage(raw: string): string {
  return Buffer.from(raw).toString('base64url');
}
```

This lives in a shared helper (e.g., `src/lib/mail-compose.ts`) used by both `/send` and `/schedule`+cron routes.

### New API routes

**`POST /api/mail/emails/send`**
- **Auth:** `requireClerkUserId()` + `getValidMailboxForUser(clerkUserId, body.mailbox)`
- **Runtime:** `nodejs`
- **Body:** `{ mailbox: string, to: string, subject: string, body: string, inReplyTo?: string, references?: string }`
- **Operation:** build RFC 2822 message (using `buildRfc2822`), base64url-encode, POST to `https://gmail.googleapis.com/gmail/v1/users/me/messages/send` with `Authorization: Bearer <accessToken>`
- **Response:** `200 { messageId: string }` on success; `200 { error: "INSUFFICIENT_SCOPE" }` on Google 403; `500 { error: string }` on other failures

**`POST /api/mail/emails/schedule`**
- **Auth:** `requireClerkUserId()` + `getValidMailboxForUser(clerkUserId, body.mailbox)` (validates the mailbox exists and token is valid at schedule time)
- **Runtime:** `nodejs`
- **Body:** `{ mailbox: string, to: string, subject: string, body: string, inReplyTo?: string, references?: string, sendAt: string }` (`sendAt` is ISO string)
- **Operation:** generate `id` (e.g., `crypto.randomUUID()`); convert `sendAt` to unix ms via `Date.parse(sendAt)` for DB storage; insert into `scheduled_emails` with `sent=0, sending=0`
- **Response:** `201 { id: string }`

**`GET /api/mail/scheduled`**
- **Auth:** `requireClerkUserId()`
- **Runtime:** `nodejs`
- **Operation:** query Turso for `sent=0` rows where `clerk_user_id = <userId>`
- **Response:** `200 { scheduled: Array<{ id: string, to: string, subject: string, sendAt: string }> }` — `sendAt` is ISO string (convert from DB integer: `new Date(row.send_at).toISOString()`)

**`GET /api/cron/send-scheduled`**
- **Auth:** check `Authorization` header equals `Bearer ${process.env.CRON_SECRET}`; return `401` if absent or wrong. **No Clerk session** — this is a machine-to-machine route.
- **Runtime:** `nodejs`
- **Token retrieval:** the route has `clerk_user_id` and `mailbox_address` from the DB rows. It calls `getValidMailboxForUser(clerkUserId, mailboxAddress)` directly (this function takes a clerk user ID string, no session required — confirmed from `mail-auth.ts`). This refreshes the OAuth token if needed.
- **TTL recovery (runs first):** `UPDATE scheduled_emails SET sending=0 WHERE sent=0 AND sending=1 AND send_at <= <Date.now() - 300000>` — resets rows stuck in `sending=1` for more than 5 minutes due to process crash or Vercel function timeout, making them eligible for retry on this invocation.
- **Concurrency guard:** single atomic UPDATE after TTL recovery: `UPDATE scheduled_emails SET sending=1 WHERE sent=0 AND sending=0 AND send_at <= <Date.now()>` — only rows affected by this UPDATE are processed in this invocation. Prevents double-send on concurrent cron fires.
- **Per claimed row:** call `getValidMailboxForUser(clerkUserId, mailboxAddress)` → build RFC 2822 → send via Gmail REST API. On success: `UPDATE SET sent=1, sending=0`. On failure: `UPDATE SET sending=0` (retry next tick).
- **Response:** `200 { sent: number }` — count of emails sent

### Turso table: `scheduled_emails`

Added inside `ensureDatabaseSchema()` in `src/lib/db.ts`:

```sql
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
```

`send_at` is stored as unix milliseconds (integer). Convert on boundaries:
- Insert: `Date.parse(sendAt)` (ISO string → ms)
- Read: `new Date(row.send_at).toISOString()` (ms → ISO string)

`sending` column acts as the idempotency lock to prevent double-sends.

### Vercel Cron (`vercel.json`)

```json
{
  "crons": [
    { "path": "/api/cron/send-scheduled", "schedule": "* * * * *" }
  ]
}
```

**Note:** every-minute cron requires Vercel Pro plan. On Vercel Hobby, change schedule to `"0 * * * *"` (hourly). For local development, invoke `GET /api/cron/send-scheduled` manually with `Authorization: Bearer <CRON_SECRET>`.

### New environment variable

| Variable | Purpose |
|---|---|
| `CRON_SECRET` | Bearer token that protects `/api/cron/send-scheduled` |

### Compose modal UI
- Full-screen overlay, same Copper/Obsidian dark theme as `EmailReader`
- Fields: To (email input), Subject (text input), body (textarea, plain text)
- **Reply pre-fill:** To = `email.from[1]` (sender address), Subject = `Re: <original subject>` (no double-`Re:`), body textarea = `\n\n---\n<original email body snippet>`
- `inReplyTo` and `references` set to the original email's `id` field for threading
- Actions: **Send** → `/api/mail/emails/send`; **Send Later** → same time-picker presets as Snooze → `/api/mail/emails/schedule`; **Discard** → confirmation dialog if body textarea is non-empty
- Send success: brief toast notification, modal closes
- `INSUFFICIENT_SCOPE` error: inline "Reconnect your mailbox in Settings to enable sending", modal stays open
- Other error: inline error message, modal stays open

Floating nav Reply button active only when email is open in reader; dimmed otherwise.

---

## 7. Gatekeeper (Real Data)

**Detection (local Jazz cache heuristic):**
- A sender is a Gatekeeper candidate if: (1) their `fromAddress` appears in **exactly one** message in the local Jazz cache, and (2) their `fromAddress` is not in `senderRules`
- Rationale: "exactly one" approximates a first-contact sender. With a 50-message initial load, a sender with two emails where only one is cached will not appear as a candidate (they have more than one message visible). This is cache-relative and intentionally approximate — the 3-card display limit and user Allow/Block actions contain any false positives.

**Display:** up to 3 candidate cards, sorted by most recent email date. Each card shows: sender name, sender address, email subject as preview. Section hidden entirely if no candidates exist (replaces the current hardcoded mock).

**Actions (Jazz only, no backend call):**
- **Allow** → push `{ address, rule: "allow" }` to Jazz `senderRules`. Email appears in normal inbox on next render.
- **Block** → push `{ address, rule: "block" }` to Jazz `senderRules`. All emails from that address permanently filtered from every view.

---

## 8. Settings & Navigation

**Settings button (header):** calls `router.push('/settings')`.

**Palette button (header):** no-op — visually present, not wired.

**Prev/Next in EmailReader:**
- `InboxClient` passes two new props to `EmailReader`: `emails: Email[]` (current sorted filtered list) and `emailIndex: number` (index of the open email)
- Previous button (`emailIndex > 0`): calls `openEmail(emails[emailIndex - 1])`; dimmed at index 0
- Next button (`emailIndex < emails.length - 1`): calls `openEmail(emails[emailIndex + 1])`; dimmed at last
- The existing "Previous Message" / "Upcoming Message" labels and arrow buttons in the UI are wired to these handlers
- Opening an email auto-marks read via existing `clearMessageNewStatus` behaviour

---

## 9. New Environment Variables

| Variable | Purpose |
|---|---|
| `CRON_SECRET` | Bearer token for `/api/cron/send-scheduled` |

Scope string change in `google-oauth.ts` requires no new env var but requires existing users to re-authorize.

---

## 10. Files to Create / Modify

### New files
- `src/lib/mail-compose.ts` — `buildRfc2822` and `encodeMessage` helpers
- `src/app/api/mail/new/route.ts` — incremental IMAP fetch by UID watermark
- `src/app/api/mail/emails/mailbox/[mailbox]/[uid]/archive/route.ts` — IMAP archive (Gmail only); sibling of existing `[uid]/route.ts`, which is **not modified**
- `src/app/api/mail/emails/send/route.ts` — immediate send via Gmail REST API
- `src/app/api/mail/emails/schedule/route.ts` — insert scheduled send into Turso
- `src/app/api/mail/scheduled/route.ts` — list unsent scheduled emails for current user
- `src/app/api/cron/send-scheduled/route.ts` — cron job to dispatch due scheduled emails
- `vercel.json` — Vercel Cron configuration

### Modified files
- `src/lib/jazz-schema.ts` — add `JazzSenderRule`, `JazzScheduledEmail` CoMaps; add `snoozedUntil`, `isArchived` to `JazzMessage`; add `senderRules`, `scheduledEmails` to `JazzInboxState`; update `resolved` map to include both new lists
- `src/providers/jazz-provider.tsx` — initialize `senderRules` and `scheduledEmails` in `ensureInboxState()`; expose new context actions: `archiveMessage`, `snoozeMessage`, `allowSender`, `blockSender`, `syncScheduledEmails`; change `syncInbox` messages from replace to append-merge
- `src/app/inbox/page.tsx` — UID watermark polling; hybrid search; snooze resurface; scheduled email sync on poll
- `src/components/inbox/inbox-client.tsx` — wire all UI elements; add Compose modal; add Snooze popover; pass `emails[]` + `emailIndex` to `EmailReader`; wire Gatekeeper to real Jazz data; wire Settings button; wire Prev/Next
- `src/lib/db.ts` — add `scheduled_emails` DDL to `ensureDatabaseSchema()`
- `src/lib/mail-store.ts` — add: `insertScheduledEmail`, `claimDueScheduledEmails`, `markScheduledEmailSent`, `clearScheduledEmailLock`, `getUnsentScheduledEmailsForUser`
- `src/lib/google-oauth.ts` — append `https://www.googleapis.com/auth/gmail.send` to OAuth scope string
- `src/lib/imap.ts` — add `archiveEmail(auth, uid)` using `withImapClient` + `getMailboxLock(INBOX)` + `messageMove`
