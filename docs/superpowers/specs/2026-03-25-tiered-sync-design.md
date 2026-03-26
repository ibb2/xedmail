# Tiered Sync Architecture — Design Spec

**Date:** 2026-03-25
**Branch:** `feat/tiered-sync`
**Depends on:** `feat/auth-betterauth` ✅ landed

---

## Overview

Replace the current Jazz-based client state with a layered sync architecture that separates email metadata (local, encrypted, offline-first) from email bodies (lazy, cached, evicted) and attachments (always streamed, never stored). Extract all IMAP logic from Next.js API routes into a dedicated Elysia (Bun) microservice — **implemented as a single `index.ts` file**. Eliminate Jazz entirely.

---

## Storage Layers

| Layer | Technology | Responsibility |
|---|---|---|
| Frontend | Next.js (Vercel or self-hosted) | UI, thin proxy routes, BetterAuth session validation |
| IMAP service | Elysia (Bun), self-hosted — single `index.ts` | IMAP IDLE daemon, metadata streaming, body/attachment serving |
| Server DB | Turso (cloud) / libsql file (self-hosted) | Mailboxes, OAuth tokens, user state (snooze, archive, rules) |
| Client DB | Dexie (IndexedDB) | EmailMetadata, body cache, FlexSearch index |

**Self-hosting**: switching from Turso cloud to local libsql requires only changing `TURSO_DATABASE_URL` to `file:local.db`. No code changes.

**Jazz**: eliminated entirely. User state (snooze, archive, reply status, sender rules) migrates to Turso. `recentSearches` is intentionally downgraded from cross-device sync to device-local only — stored in Dexie. This is an acceptable behaviour change.

---

## Architecture Diagram

```
Browser
  ├── Dexie (IndexedDB)
  │     ├── emails table (EmailMetadata)
  │     ├── bodies table (body cache)
  │     ├── searchIndex table (FlexSearch snapshot)
  │     ├── syncState table (cursors + watermarks + totalBodyBytes)
  │     └── recentSearches table (device-local)
  │
  └── Next.js (Vercel)
        ├── BetterAuth session validation
        └── Proxy routes → Elysia (REST: body, attachments)

Browser ←──SSE / WebSocket──→ Elysia (direct, CORS-gated — see Auth section)

Elysia service (Bun, Railway / Fly.io / self-hosted) — services/mail/index.ts
  ├── IMAP IDLE daemon (one connection per mailbox, INBOX only)
  ├── GET  /stream        → SSE: metadata batches + backfill_complete event
  ├── WS   /events        → WebSocket: real-time delta events (EXISTS/EXPUNGE/FETCH)
  ├── GET  /body/:emailId → streams body from IMAP (via Next.js proxy)
  └── GET  /attachments/:emailId/:attachmentId → streams attachment (via Next.js proxy)

Turso / libsql
  ├── mailboxes (existing)
  ├── oauth_states (existing)
  ├── scheduled_emails (existing)
  ├── user_profiles (existing)
  └── user_state (NEW — see schema below)
```

---

## Elysia Service — Single File

The entire Elysia service lives in `services/mail/index.ts`. All concerns — route definitions, IMAP IDLE daemon, reconnection logic, `seqToUid` map maintenance, BetterAuth session validation, and CORS — are implemented in this one file. No subdirectories, no module splitting.

`services/mail/package.json` declares runtime dependencies only: `elysia`, `imapflow`, `@libsql/client`, `drizzle-orm`. Dev dependency: `drizzle-kit` (for migrations).

---

## Authentication

### SSE and WebSocket (browser → Elysia directly)

The browser connects to Elysia directly for SSE and WebSocket — proxying a long-lived SSE stream through Next.js serverless functions is not viable on Vercel.

**Session token delivery:** The browser passes the BetterAuth session token as a URL query parameter (`?token=<value>`). The token is the raw value from the `better-auth.session_token` cookie, read via `document.cookie` or the BetterAuth client's `getSession()` response. **Security note:** passing tokens in query params risks exposure in server access logs. This is acceptable for the initial implementation (localhost + self-hosted); a short-lived exchange token should replace it before public deployment.

**Session validation:** BetterAuth stores session tokens as plain strings in the `session` table (`token` column). Elysia validates using Drizzle:
```typescript
const row = await db.select().from(sessionTable)
  .where(eq(sessionTable.token, token))
  .limit(1);
if (!row[0] || row[0].expiresAt < new Date()) reject();
```
Elysia has its own `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` and its own Drizzle instance. No call back to Next.js is made.

**Session expiry during live connection:** On expiry detected at connection time or on periodic re-check (every 5 minutes), Elysia sends `{ type: "auth_error", reason: "session_expired" }` and closes the connection. The client refreshes the session via BetterAuth, then re-opens the connection with the new token.

**CORS:** Elysia sets `Access-Control-Allow-Origin` to `CORS_ORIGIN` (the Next.js origin). All other origins are rejected.

### REST requests (browser → Next.js → Elysia)

Body and attachment fetches go through Next.js proxy routes. Next.js validates the BetterAuth session via `auth.api.getSession()`, then forwards to Elysia with the `X-Service-Secret: <ELYSIA_SERVICE_SECRET>` header. Elysia rejects any REST request without a valid `X-Service-Secret`. `ELYSIA_SERVICE_SECRET` is never exposed to the browser.

---

## Turso Schema Addition

Defined with Drizzle schema (inline in `services/mail/index.ts` — no separate schema file):

```typescript
import { sqliteTable, text, integer, unique } from "drizzle-orm/sqlite-core";

const sessionTable = sqliteTable("session", {
  id:        text("id").primaryKey(),
  token:     text("token").notNull(),
  userId:    text("user_id").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
});

const userState = sqliteTable("user_state", {
  id:           text("id").primaryKey(),
  userId:       text("user_id").notNull(),
  emailId:      text("email_id").notNull(),   // `${mailboxAddress}:${uid}`
  isArchived:   integer("is_archived", { mode: "boolean" }).notNull().default(false),
  snoozedUntil: integer("snoozed_until"),     // Unix ms, null if not snoozed
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
```

Drizzle migrations (`drizzle-kit generate` + `drizzle-kit migrate`) create these tables. Migration files live in `services/mail/drizzle/`.

---

## Part 1 — Metadata-First Sync

### EmailMetadata type

```typescript
type EmailMetadata = {
  id: string;           // Composite key: `${mailboxAddress}:${uid}` — mailboxAddress is the email address string (e.g. "user@gmail.com"), NOT the Turso mailbox UUID
  mailboxId: string;    // Same as mailboxAddress — the Gmail/IMAP email address
  uid: number;          // Raw IMAP UID within the mailbox
  threadId: string;     // X-GM-THRID as string (Gmail only; empty string for non-Gmail)
  subject: string;
  fromName: string;
  fromAddress: string;
  date: number;         // Unix timestamp ms
  snippet: string;      // First 200 chars, plain text, HTML stripped
  isRead: boolean;      // \Seen IMAP flag
  isStarred: boolean;   // \Flagged IMAP flag
  labels: string[];     // X-GM-LABELS (Gmail only; empty array otherwise)
  hasAttachments: boolean;
};
```

**`id` and `mailboxId`** both use the email address string (e.g. `"user@gmail.com:12345"`), matching the existing `EmailDto.id` convention. This is also the value stored in `user_state.email_id`.

**Gmail extension attributes:** `X-GM-THRID` and `X-GM-LABELS` are non-standard IMAP extensions. They must be explicitly listed in the ImapFlow `FETCH` attributes: `['envelope', 'flags', 'bodyStructure', 'internalDate', 'X-GM-THRID', 'X-GM-LABELS']`. ImapFlow exposes them on the message object as `message.gmailThreadId` and `message.gmailLabels` respectively. For non-Gmail providers these attributes are silently absent — Elysia sets `threadId: ""` and `labels: []` as fallbacks.

### Dexie schema (version 1)

```
emails:          &id, mailboxId, date, fromAddress, isRead, threadId
bodies:          &id, lastAccessed, byteSize
searchIndex:     &field, snapshot
syncState:       &key, value
recentSearches:  ++id, searchedAt
```

**syncState keys** (string key → JSON-serialised value):

| Key | Value type | Description |
|---|---|---|
| `backfillCursor_{mailboxId}` | `number` | Lowest UID reached during backfill |
| `backfillComplete_{mailboxId}` | `boolean` | True when backfill reached UID 1 |
| `watermarkUid_{mailboxId}` | `number` | Highest UID seen; used to catch up after reconnect |
| `totalBodyBytes` | `number` | Running compressed byte total for eviction |

**Schema migration policy:** any schema change increments the Dexie version number and clears `emails`, `bodies`, `searchIndex`, and `syncState` on `onupgradeneeded` (full re-sync). `recentSearches` is preserved across migrations.

**Post-migration re-sync trigger:** after `onupgradeneeded` runs, the sync provider detects that the `emails` table is empty and automatically re-opens the SSE connection from scratch (no cursor). The UI displays a loading state during this period. No manual user action is required.

### Sync flow

**Initial load (eager, 500 emails):**
1. Browser opens SSE connection directly to Elysia `/stream?mailbox=X&token=<session>`
2. Elysia fetches latest 500 UIDs from IMAP INBOX; fetches envelope + flags + bodyStructure per message (including `X-GM-THRID` and `X-GM-LABELS` for Gmail)
3. Streams batches of 50 as SSE `data:` events with `type: "batch"`
4. Browser writes each batch to Dexie; UI renders from Dexie (inbox visible within first batch, <2s)
5. Sets `watermarkUid_{mailboxId}` to the highest UID seen across all batches

**Background backfill (progressive, remaining history):**
1. SSE stream continues after initial 500
2. Elysia works backwards by UID in **batches of 200**
3. Browser writes batches to Dexie via `requestIdleCallback` (`setTimeout(fn, 0)` fallback for Safari)
4. `syncState.backfillCursor_{mailboxId}` tracks lowest UID reached — resumes from cursor on page reload
5. When complete, Elysia emits `{ type: "backfill_complete", mailboxId }`. Browser sets `backfillComplete_{mailboxId} = true`. SSE connection closes.

**On page reload mid-backfill:** browser reads `backfillCursor_{mailboxId}` from Dexie and opens SSE with `?cursor=<uid>`. Elysia resumes backfill from that UID downward.

**Storage estimate:** ~1–1.5KB per email row. 100k emails ≈ 100–150MB — well within 500MB target.

### IMAP connections

Elysia maintains **one IMAP IDLE connection per mailbox per user** (INBOX only). Non-INBOX folders (Sent, Drafts, Spam) polled every 5 minutes — fetches only EXISTS count and new UIDs since `watermarkUid`. Events pushed over WebSocket.

**IMAP connection limit (Gmail):** Gmail allows 15 concurrent IMAP connections per account. This constrains the service; multiplexing is deferred. Document as a known operational constraint.

### EXPUNGE UID resolution

Elysia maintains an in-memory `seqToUid: number[]` array per mailbox, populated on `SELECT INBOX` via `UID FETCH 1:* (UID)` and updated on every `EXISTS` and `EXPUNGE` event. On `EXPUNGE seq`: read `seqToUid[seq - 1]`, splice the array, send delete event with resolved UID.

| IMAP event | Elysia action | Browser action |
|---|---|---|
| `EXISTS` | Fetch new message metadata, append to `seqToUid`, update `watermarkUid` | Upsert into Dexie, add to FlexSearch |
| `EXPUNGE` | Resolve UID via `seqToUid`, splice array | Delete from Dexie `emails` + `bodies` |
| `FETCH` (flags) | Send flag-update event with UID + new flags | Patch `isRead` / `isStarred` in Dexie |

### IMAP reconnection strategy

On connection drop (`error` or `close` from ImapFlow):
1. Elysia emits `{ type: "reconnecting", mailboxId }` to browser
2. Exponential backoff: 1s → 2s → 4s → 8s → max 60s
3. On reconnect: re-`SELECT INBOX`, rebuild `seqToUid` via `UID FETCH 1:* (UID)`, fetch all UIDs > `watermarkUid` to catch missed messages
4. Emit `{ type: "reconnected", mailboxId }` — browser reconciles delta

---

## Part 2 — Body on Demand

### Hook

```typescript
function useEmailBody(id: string): {
  body: string | null;
  attachments: AttachmentManifest[];
  loading: boolean;
  error: Error | null;
}
```

### Flow

1. Check Dexie `bodies` — cache hit: decompress (`DecompressionStream`), update `lastAccessed = now`, return immediately
2. Cache miss: `GET /api/mail/body/:id` → Next.js proxy → Elysia
3. Elysia fetches body from IMAP (HTML preferred, plain text fallback), parses `bodyStructure` for attachment manifest (filename, size, MIME type — no content)
4. **If body ≤ 5MB compressed:** compress via `CompressionStream` (`gzip` format), write to Dexie `bodies` with `lastAccessed = now`, increment `totalBodyBytes` by compressed byte length
5. **If body > 5MB compressed:** stream directly to UI — do not write to Dexie
6. Return `{ body, attachments }`

**`lastAccessed` update:** updated on every read (cache hit or miss), in the same Dexie write transaction as any body write.

**Error handling:** on IMAP failure, hook returns `{ error, body: null }`. UI renders "could not load email" with a retry button. No stale body shown.

### Eviction policy

Runs on every body write and on app startup:
- **Size-based (primary):** if `totalBodyBytes` exceeds `MAX_BODY_CACHE_MB` (default 500MB, configurable via env), evict LRU bodies (sorted `lastAccessed` asc) until under limit. Decrement `totalBodyBytes` per eviction.
- **Time-based (secondary):** on startup only, delete all bodies where `lastAccessed < now - 30 days`. Decrement `totalBodyBytes` accordingly.
- Metadata (`emails` table) is **never evicted**.

---

## Part 3 — Attachment Streaming

### Request path

Attachment requests follow the same REST path as body requests: **browser → Next.js proxy → Elysia**. Next.js validates the session and forwards with `X-Service-Secret`. Elysia streams the IMAP part directly as `ReadableStream` with correct `Content-Type` and `Content-Disposition: attachment` headers. Never buffers the full attachment in memory.

### Client

```typescript
// Inline (PDFs, images)
async function streamAttachment(emailId: string, attachmentId: string): Promise<ReadableStream>

// Download to disk
async function downloadAttachment(emailId: string, attachmentId: string, filename: string): Promise<void>
```

- **File System Access API (Chrome):** pipes stream into `showSaveFilePicker` via `WritableStream` — no blob in memory, no effective size limit
- **Fallback (Firefox + others):** collects stream into a blob, triggers download via `URL.createObjectURL`. No progress indication in fallback — acceptable for initial implementation.

Attachments are **never written to Dexie or Turso**.

---

## Part 4 — Local FlexSearch Index

### Index configuration

```typescript
const index = new Document({
  document: {
    id: 'id',
    index: [
      { field: 'subject',     tokenize: 'forward' },
      { field: 'fromName',    tokenize: 'forward' },
      { field: 'fromAddress', tokenize: 'forward' },
      { field: 'snippet',     tokenize: 'forward' },
    ],
  },
  cache: true,
});
```

### Build and persistence

- Built incrementally as SSE batches arrive — each batch adds to the in-memory index
- **Snapshot persistence:** after every 500 *new* emails added since the last snapshot, call `index.export()` and write to Dexie `searchIndex`. Each FlexSearch field exports to a separate row: `{ field: 'subject', snapshot: <serialised> }`. Snapshot writes are async (non-blocking).
- On app start: rehydrate index from Dexie snapshot before first search — fully offline after initial backfill

### Search flow

1. Query hits local FlexSearch index → returns matching `id`s
2. IDs looked up in Dexie `emails` for display
3. Zero local results + `backfillComplete = false` → fallback: `GET /api/mail/search?q=<query>&mailbox=<id>` → Next.js proxy → Elysia IMAP `SEARCH TEXT <query>` → returns array of `EmailMetadata`
4. Zero local results + `backfillComplete = true` → display empty results (no fallback)

**IMAP SEARCH endpoint shape:**
```
GET /search?mailbox=<mailboxId>&q=<query>
Authorization: X-Service-Secret header (Next.js proxy only)
Response: { emails: EmailMetadata[] }
```

---

## Jazz Elimination

| Jazz feature | Replacement |
|---|---|
| `JazzMessage` (email cache) | Dexie `emails` table |
| `JazzInboxState.messages` | Dexie queries |
| `JazzInboxState.folders` | Fetched from Elysia on demand |
| `JazzInboxState.mailboxes` | Turso `mailboxes` table (existing) |
| `JazzInboxState.senderRules` | Turso `sender_rules` table (new) |
| `JazzInboxState.recentSearches` | Dexie `recentSearches` table (device-local) |
| Snooze / archive / reply status | Turso `user_state` table (new) |
| `jazz-provider.tsx` | Deleted |
| `jazz-schema.ts` | Deleted |

**Removing `jazzPlugin` from `auth.ts`:** The Jazz plugin added `accountID` and `encryptedCredentials` columns to BetterAuth's `user` table. Removing the plugin from `auth.ts` stops writing these columns; existing values are ignored but remain in the DB as inert dead data. No DB migration is required — SQLite ignores extra columns when `jazzPlugin` is absent. The `jazz-tools` package is removed from `package.json` entirely.

---

## Commit Plan

```
feat: add Elysia IMAP service (services/mail/index.ts)
  - SSE /stream, WS /events, GET /body/:id, GET /attachments/:id/:part
  - IMAP IDLE daemon, seqToUid, reconnection, session validation via Turso

feat: metadata-first sync — Dexie schema + SSE stream client
  - Dexie schema v1 (emails, bodies, searchIndex, syncState, recentSearches)
  - SSE consumer: initial 500 + backfill via requestIdleCallback
  - WebSocket consumer: EXISTS/EXPUNGE/FETCH delta handling
  - Turso user_state + sender_rules migration

feat: lazy body fetching with LRU cache eviction
  - useEmailBody hook, /api/mail/body/:id proxy route
  - CompressionStream cache, eviction policy

feat: attachment streaming
  - /api/mail/attachments/:id/:part proxy route
  - downloadAttachment + streamAttachment client helpers

feat: local FlexSearch metadata index
  - Document index, incremental build from SSE batches
  - Dexie snapshot persistence, startup rehydration
  - /api/mail/search proxy + Elysia IMAP SEARCH fallback

chore: remove Jazz
  - Delete jazz-provider.tsx, jazz-schema.ts
  - Remove jazz-tools dependency
  - Update inbox/page.tsx to use Dexie hooks
```

---

## Environment Variables

### Next.js (additions)
```
ELYSIA_SERVICE_URL        # e.g. https://mail.yourdomain.com
ELYSIA_SERVICE_SECRET     # shared secret for Next.js → Elysia REST proxy auth
```

### Elysia service (`services/mail/index.ts`)
```
TURSO_DATABASE_URL        # same as Next.js — used for session validation
TURSO_AUTH_TOKEN
IMAP_HOST
IMAP_PORT
IMAP_SECURE
ELYSIA_SERVICE_SECRET     # validates inbound REST requests from Next.js proxy
CORS_ORIGIN               # Next.js origin, e.g. https://yourdomain.com
```
