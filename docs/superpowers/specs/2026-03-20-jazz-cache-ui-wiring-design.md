# Design: Jazz-first Email Cache & UI Wiring

**Date:** 2026-03-20
**Status:** Approved

---

## Overview

Two related goals:

1. **Jazz-first data flow** — stop hitting IMAP on every search/poll. Use Jazz as the source of truth; only fetch new messages from IMAP (UID watermark strategy).
2. **Wire up all UI elements** — Archive, Snooze, Reply (with scheduled send), Gatekeeper, Settings navigation, and Prev/Next email navigation.

---

## 1. Jazz Schema Changes

### `JazzMessage` — two new fields
- `snoozedUntil: z.optional(z.string())` — ISO date; hides email from inbox until this time passes
- `isArchived: z.optional(z.boolean())` — set client-side after successful IMAP archive

### `JazzMailbox` — one new field
- `lastKnownUid: z.optional(z.number())` — highest IMAP UID seen for this mailbox; drives incremental fetch

### New `JazzSenderRule` CoMap
```ts
{ address: z.string(), rule: z.enum(["allow", "block"]) }
```

### New `JazzScheduledEmail` CoMap
```ts
{ id: z.string(), to: z.string(), subject: z.string(), sendAt: z.string() }
```

### `JazzInboxState` — two new fields
- `senderRules: co.list(JazzSenderRule)` — whitelist/blacklist for Gatekeeper
- `scheduledEmails: co.list(JazzScheduledEmail)` — pending scheduled sends visible to the user

No existing fields removed. Migration initializes `senderRules` and `scheduledEmails` as empty lists on first account load.

---

## 2. Incremental Sync (Jazz-first Data Flow)

### Current flow (replaced)
Every 30s poll → IMAP full fetch → replace all Jazz messages → render

### New flow

**Initial load (Jazz empty):**
1. Render immediately from Jazz (empty state, no spinner)
2. Hit `/api/mail/search` (no query, limit 50) — existing route
3. Store results in Jazz; derive `lastKnownUid` per mailbox as `max(uid)` of returned messages

**Subsequent polls (Jazz has data):**
1. Render immediately from Jazz — no loading spinner on poll
2. Hit `GET /api/mail/new?minUid=<uid>&mailbox=<addr>` per mailbox
3. Merge only new emails into Jazz (append, dedup by `mailboxAddress:uid`)
4. Update `lastKnownUid` if new messages arrived

**`lastKnownUid` derivation:** computed client-side from Jazz messages (`max` of all `uid` values per mailbox). No server-side tracking needed.

**Snooze resurface:** piggybacked on each poll — scan Jazz messages where `snoozedUntil ≤ now`, clear the field, set `isNew = true`.

### New API route: `GET /api/mail/new`
- Params: `minUid` (number), `mailbox` (email address)
- IMAP: `search({ uid: { min: minUid + 1 } })`
- Returns: `{ emails: EmailDto[] }` — empty array is the common case
- Auth: same `requireClerkUserId` + `getValidMailboxForUser` pattern

---

## 3. Search (Hybrid)

1. Filter Jazz messages where `subject`, `fromName`, or `fromAddress` contains the query (case-insensitive)
2. If results ≥ 5 → return immediately, no IMAP call
3. If results < 5 → also hit `/api/mail/search?query=<q>` (existing route)
4. Merge IMAP results into Jazz (dedup by `mailboxAddress:uid`), return combined set

### Inbox view filters (always applied)
- `snoozedUntil > now` → hidden
- `isArchived = true` → hidden
- Sender in `senderRules` with `rule = "block"` → hidden

---

## 4. Archive

**New API route:** `POST /api/mail/emails/mailbox/[mailbox]/[uid]/archive`
- IMAP: `messageMove(uid, '[Gmail]/All Mail', { uid: true })` — removes from INBOX, preserves email
- Returns `204` on success

**Client:**
- On success: set `isArchived = true` on the Jazz message → instantly removed from view
- Floating nav Archive button is active only when an email is open in the reader

---

## 5. Snooze

**UI:** Clicking Snooze opens a popover with presets:
- Later today (+3h)
- Tomorrow (9am)
- Next week (Monday 9am)
- Custom (date/time picker)

**Storage:** `snoozedUntil` ISO string on the Jazz message — no backend call needed.

**Resurface:** On each 30s poll, scan Jazz messages where `snoozedUntil ≤ now`, clear the field, set `isNew = true`.

Floating nav Snooze button active only when an email is open in the reader.

---

## 6. Reply & Compose (with Scheduled Send)

### Sending mechanism
Gmail REST API (`POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send`) using the existing OAuth access token.

**OAuth scope addition required:** `https://www.googleapis.com/auth/gmail.send`

Emails formatted as RFC 2822, base64url-encoded.

### New API routes
- `POST /api/mail/emails/send` — sends immediately via Gmail REST API
  Body: `{ mailbox, to, subject, body, inReplyTo?, references? }`
  Returns: `{ messageId }`

- `POST /api/mail/emails/schedule` — stores scheduled send in Turso
  Body: `{ mailbox, to, subject, body, inReplyTo?, references?, sendAt }`
  Inserts into `scheduled_emails` table, syncs a `JazzScheduledEmail` entry

- `GET /api/cron/send-scheduled` — protected by `CRON_SECRET` header
  Queries Turso for `sent = false AND send_at <= now`, sends each via Gmail REST API, marks `sent = true`, removes from Jazz `scheduledEmails`

### New Turso table: `scheduled_emails`
```sql
CREATE TABLE scheduled_emails (
  id TEXT PRIMARY KEY,
  clerk_user_id TEXT NOT NULL,
  mailbox_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  in_reply_to TEXT,
  references TEXT,
  send_at INTEGER NOT NULL,  -- unix timestamp
  sent INTEGER NOT NULL DEFAULT 0
);
```

### Vercel Cron (`vercel.json`)
```json
{
  "crons": [{ "path": "/api/cron/send-scheduled", "schedule": "* * * * *" }]
}
```

New env var: `CRON_SECRET`

### Compose modal UI
- Full-screen overlay, same Copper/Obsidian theme as `EmailReader`
- Fields: To, Subject, body textarea (plain text)
- **Reply pre-fill:** To = original sender, Subject = `Re: <original>`, quoted body below `---`
- Actions: **Send** (immediate), **Send Later** (time picker → schedule), **Discard** (confirm if body non-empty)
- Send success: brief toast, close modal
- Send failure: inline error, modal stays open

Floating nav Reply button active only when an email is open in the reader.

---

## 7. Gatekeeper (Real Data)

**Detection:** senders whose `fromAddress` appears in exactly one message in Jazz AND has no entry in `senderRules`.

**Display:** up to 3 cards with real sender name, email address, and email subject as preview. Section hidden entirely if no first-time senders exist.

**Actions:**
- **Allow** → push `{ address, rule: "allow" }` to `senderRules`; email moves into normal inbox view
- **Block** → push `{ address, rule: "block" }` to `senderRules`; all emails from that sender filtered from every view permanently

No backend call needed — all state lives in Jazz.

---

## 8. Settings & Navigation

**Settings button (header):** navigates to `/settings`.

**Palette button:** no-op for now (placeholder, not wired).

**Prev/Next in EmailReader:**
- `InboxClient` passes the sorted filtered email list and current index to `EmailReader`
- Previous/Next buttons navigate to adjacent email (skipping archived/snoozed)
- Opening an email auto-marks it as read (existing behaviour preserved)

---

## 9. New Environment Variables

| Variable | Purpose |
|---|---|
| `CRON_SECRET` | Protects `/api/cron/send-scheduled` from public access |

OAuth scope `https://www.googleapis.com/auth/gmail.send` must be added to the Google OAuth configuration.

---

## 10. Files to Create / Modify

### New files
- `src/app/api/mail/new/route.ts` — incremental IMAP fetch
- `src/app/api/mail/emails/mailbox/[mailbox]/[uid]/archive/route.ts` — IMAP archive
- `src/app/api/mail/emails/send/route.ts` — immediate send via Gmail REST
- `src/app/api/mail/emails/schedule/route.ts` — schedule a send
- `src/app/api/cron/send-scheduled/route.ts` — cron job to dispatch scheduled emails
- `vercel.json` — cron configuration

### Modified files
- `src/lib/jazz-schema.ts` — add new CoMaps and fields
- `src/providers/jazz-provider.tsx` — expose new actions (archive, snooze, senderRules, scheduledEmails)
- `src/app/inbox/page.tsx` — UID watermark polling, hybrid search, snooze resurface
- `src/components/inbox/inbox-client.tsx` — wire all UI elements
- `src/lib/db.ts` — add `scheduled_emails` table creation
- `src/lib/mail-store.ts` — queries for scheduled emails
- `src/lib/google-oauth.ts` — add `gmail.send` scope
