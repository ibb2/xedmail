# Tiered Sync Architecture — Design Spec

**Date:** 2026-03-21
**Branch:** `feat/tiered-sync`
**Depends on:** `feat/auth-betterauth` (must land first)

---

## Overview

Replace the current Jazz-based client state with a layered sync architecture that separates email metadata (local, encrypted, offline-first) from email bodies (lazy, cached, evicted) and attachments (always streamed, never stored). Extract all IMAP logic from Next.js API routes into a dedicated Elysia (Bun) microservice. Eliminate Jazz entirely.

---

## Storage Layers

| Layer | Technology | Responsibility |
|---|---|---|
| Frontend | Next.js (Vercel or self-hosted) | UI, thin proxy routes, BetterAuth session validation |
| IMAP service | Elysia (Bun), self-hosted | IMAP IDLE daemon, metadata streaming, body/attachment serving |
| Server DB | Turso (cloud) / libsql file (self-hosted) | Mailboxes, OAuth tokens, user state (snooze, archive, rules) |
| Client DB | Dexie + dexie-encrypted (IndexedDB) | EmailMetadata, body cache, FlexSearch index |

**Self-hosting**: switching from Turso cloud to local libsql requires only changing `TURSO_DATABASE_URL` to `file:local.db`. No code changes.

**Jazz**: eliminated entirely. User state (snooze, archive, reply status, sender rules) migrates to Turso. `recentSearches` is intentionally downgraded from cross-device sync to device-local only — stored in Dexie, not synced via Turso. This is an acceptable behaviour change.

---

## Architecture Diagram

```
Browser
  ├── Dexie (IndexedDB, encrypted)
  │     ├── emails table (EmailMetadata)
  │     ├── bodies table (body cache)
  │     ├── searchIndex table (FlexSearch snapshot)
  │     └── syncState table (cursors + watermarks + totalBodyBytes)
  │
  └── Next.js (Vercel)
        ├── BetterAuth session validation
        └── Proxy routes → Elysia (REST: body, attachments)

Browser ←──SSE / WebSocket──→ Elysia (direct, CORS-gated — see Auth section)

Elysia service (Bun, Railway / Fly.io / self-hosted)
  ├── IMAP IDLE daemon (one connection per mailbox, INBOX only)
  ├── GET  /stream        → SSE: metadata batches + backfill_complete event
  ├── WS   /events        → WebSocket: real-time delta events (EXISTS/EXPUNGE/FETCH)
  ├── GET  /body/:emailId → streams body from IMAP
  └── GET  /attachments/:emailId/:attachmentId → streams attachment

Turso / libsql
  ├── mailboxes (existing)
  ├── oauth_states (existing)
  ├── scheduled_emails (existing)
  ├── user_profiles (existing)
  └── user_state (NEW: snooze, archive, reply_status, sender_rules — shared across devices)
      Note: local UI preferences (sort order, theme) stay in Dexie, not synced.
```

---

## Authentication

**SSE and WebSocket (browser → Elysia directly):**
The browser connects to Elysia directly for SSE and WebSocket — proxying a long-lived SSE stream through Next.js serverless functions is not viable on Vercel. Elysia validates the BetterAuth session token passed as a query parameter or `Authorization` header. Elysia is configured with `BETTERAUTH_SECRET` to verify tokens independently, without calling back to Next.js.

Elysia must set CORS headers to allow requests from the Next.js origin only:
```
Access-Control-Allow-Origin: https://yourdomain.com
```

**REST requests (browser → Next.js → Elysia):**
Body and attachment fetches go through Next.js proxy routes. Next.js validates the BetterAuth session, then forwards to Elysia with the `ELYSIA_SERVICE_SECRET` header. Elysia rejects any REST request without this header. `ELYSIA_SERVICE_SECRET` is never exposed to the browser.

---

## Part 1 — Metadata-First Sync

### EmailMetadata type

```typescript
type EmailMetadata = {
  id: string;           // Composite key: `${mailboxId}:${uid}` — unique across mailboxes
  mailboxId: string;    // Mailbox identifier (email address)
  uid: number;          // Raw IMAP UID within the mailbox
  threadId: string;     // X-GM-THRID (Gmail only — must be explicitly requested in FETCH; empty string otherwise)
  subject: string;
  fromName: string;
  fromAddress: string;
  date: number;         // Unix timestamp ms (deliberate change from existing EmailDto.date which is ISO string)
  snippet: string;      // First 200 chars, plain text, HTML stripped
  isRead: boolean;      // \Seen IMAP flag
  isStarred: boolean;   // \Flagged IMAP flag
  labels: string[];     // X-GM-LABELS (Gmail only — must be explicitly requested in FETCH; empty array otherwise)
  hasAttachments: boolean; // Derived from bodyStructure during metadata fetch
};
```

**Gmail extension attributes** (`X-GM-THRID`, `X-GM-LABELS`) are not fetched by ImapFlow automatically — they must be explicitly included in the IMAP `FETCH` attribute list. The Elysia metadata fetch must request them by name. They are silently omitted for non-Gmail providers.

### Dexie schema (version 1)

```
emails:        &id, mailboxId, date, fromAddress, isRead, threadId
bodies:        &id, lastAccessed, byteSize
searchIndex:   &field, snapshot
syncState:     &key, value
```

`emails` indexed on `date`, `fromAddress`, `isRead`, `threadId` for fast filter queries. `id` is the composite key `${mailboxId}:${uid}`.

**Schema migration policy:** version 1 at launch. Any schema change increments the Dexie version number and triggers a full re-sync by clearing `emails`, `bodies`, and `searchIndex` tables on `onupgradeneeded`. `syncState` is also cleared so backfill restarts cleanly.

### Sync flow

**Initial load (eager, 500 emails):**
1. Browser opens SSE connection directly to Elysia `/stream?mailbox=X` with BetterAuth token
2. Elysia fetches latest 500 UIDs from IMAP INBOX, fetches envelope + flags + bodyStructure per message (including `X-GM-THRID` and `X-GM-LABELS` for Gmail)
3. Streams batches of 50 as SSE `data:` events with `type: "batch"`
4. Browser writes each batch to Dexie `emails` table
5. UI renders from Dexie — inbox visible within the first batch (~50 emails, <2s)

**Background backfill (progressive, remaining history):**
1. SSE stream continues after initial 500
2. Elysia works backwards by UID in batches of 200
3. Browser writes batches to Dexie via `requestIdleCallback` (with `setTimeout(fn, 0)` fallback for Safari) to avoid UI jank
4. `syncState.backfillCursor` tracks lowest UID reached — resumes from cursor if interrupted
5. When cursor reaches UID 1 or mailbox beginning, Elysia emits a final SSE event: `{ type: "backfill_complete", mailboxId }`. Browser sets `syncState.backfillComplete = true` in Dexie. SSE connection closes.

**Storage estimate:** ~1–1.5KB per email row (envelope + snippet + indices). 100k emails ≈ **100–150MB** — well within 500MB target. Validate empirically during initial smoke test.

### IMAP delta events (real-time updates)

Elysia maintains **one IMAP IDLE connection per mailbox** (INBOX only). Non-INBOX folders (Sent, Drafts, Spam) are polled every 5 minutes — polling fetches only EXISTS count and new UIDs since last watermark, not full metadata. Events are pushed over WebSocket.

**EXPUNGE UID resolution:** The IMAP `EXPUNGE` response delivers a *sequence number*, not a UID. Elysia maintains an in-memory array (`seqToUid: number[]`) mapping sequence numbers to UIDs, populated on `SELECT INBOX` and updated on every `EXISTS` and `EXPUNGE` event. On `EXPUNGE seq`, Elysia reads `seqToUid[seq - 1]` to get the UID, splices the array, then sends the delete event with the resolved UID.

| IMAP event | Elysia action | Browser action |
|---|---|---|
| `EXISTS` | Fetch new message metadata, append to `seqToUid` | Upsert into Dexie, add to FlexSearch |
| `EXPUNGE` | Resolve UID via `seqToUid`, splice array | Delete from Dexie `emails` + `bodies` |
| `FETCH` (flags) | Send flag-update event with UID + new flags | Patch `isRead` / `isStarred` in Dexie |

### IMAP reconnection strategy

IMAP IDLE connections drop regularly (Gmail forces reconnect every ~29 minutes; network interruptions are common). On connection drop (`error` or `close` event from ImapFlow):

1. Elysia emits a WebSocket event `{ type: "reconnecting", mailboxId }` to the browser
2. Elysia waits with exponential backoff: 1s → 2s → 4s → 8s → max 60s
3. On reconnect: re-SELECT INBOX, rebuild `seqToUid` map from scratch (IMAP `UID FETCH 1:* (UID)`)
4. Fetch any UIDs greater than `watermarkUid` to catch missed messages during the outage
5. Emit `{ type: "reconnected", mailboxId }` — browser reconciles any missed deltas by re-requesting the watermark diff

**IMAP connection limit (Gmail):** Gmail allows 15 concurrent IMAP connections per account. Initial implementation uses one IDLE connection per mailbox. For a multi-user deployment, this constrains the service to 15 users with one Gmail account each (or fewer with multiple accounts per user). Multiplexing is deferred; document this as a known operational constraint.

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

1. Hook checks Dexie `bodies` table first — if hit, decompress (`DecompressionStream`) and return immediately (no network)
2. On cache miss: fetch `/api/mail/body/:id` → proxied via Next.js to Elysia
3. Elysia fetches full body from IMAP (HTML preferred, plain text fallback), parses `bodyStructure` for attachment manifest (filename, size, MIME type — no content)
4. Returns body + attachment manifest
5. Browser compresses body via `CompressionStream` (60–70% reduction), writes to Dexie with `lastAccessed = now`, `byteSize` = compressed byte length

**Error handling:** on IMAP fetch failure (connection dropped, email deleted, token expired), the hook sets `error` and returns `body: null`. The UI renders a "could not load email" state with a retry button. No stale body is shown for a failed fetch. On retry the hook re-fetches; no special backoff is applied at the hook level (IMAP reconnection handles backoff at the Elysia level).

### Eviction policy

Runs on **every body write** and on **app startup**:

- **Size-based (primary)**: `syncState.totalBodyBytes` is a persisted running counter in Dexie (loaded on startup, incremented/decremented on writes/evictions). If counter exceeds `MAX_BODY_CACHE_MB` (default 500MB, configurable), evict LRU bodies (sorted by `lastAccessed` asc) until under limit.
- **Time-based (secondary)**: on app startup, delete all bodies where `lastAccessed < now - 30 days`. Decrement `totalBodyBytes` accordingly.
- Metadata record in `emails` table is **never evicted** — only the body entry is removed.
- Bodies larger than 5MB (compressed) are not cached — served directly without writing to Dexie.

### Performance penalties

| Penalty | Impact | Mitigation |
|---|---|---|
| Cold open latency | 200–800ms IMAP round-trip on first open | Prefetch body of topmost unread email in viewport |
| Large emails | Single 500KB newsletter ≈ 0.1% of cache | Bodies >5MB not cached; `byteSize` tracked |
| Eviction cost | LRU sort when over limit | Running `totalBodyBytes` counter avoids full table scan; sort only triggers when over limit |

---

## Part 3 — Attachment Streaming

### Server (Elysia)

`GET /attachments/:emailId/:attachmentId`

1. Fetch `bodyStructure` from IMAP (reuses cached structure from body fetch if available in-process)
2. Locate attachment part by `attachmentId` (MIME part path, e.g. `"2.1"`)
3. Stream part directly as `ReadableStream` with correct `Content-Type` and `Content-Disposition` headers
4. Never buffers full attachment in memory — IMAP stream pipes directly to HTTP response

### Client

**Inline rendering** (PDFs, images):
```typescript
async function streamAttachment(emailId: string, attachmentId: string): Promise<ReadableStream>
```
Returns `response.body` directly for rendering in `<iframe>` or `<img>`.

**Download to disk** (File System Access API):
```typescript
async function downloadAttachment(
  emailId: string,
  attachmentId: string,
  filename: string
): Promise<void>
```
Opens `showSaveFilePicker`, pipes stream directly into the file handle via `WritableStream`. No blob held in memory — no effective size limit.

**Fallback** (Firefox / no File System Access API):
Collects stream into a blob, triggers download via `URL.createObjectURL`. Standard browser download behaviour.

### Constraints

- Attachments are **never written to Dexie or Turso**
- `hasAttachments` in metadata is derived at metadata-fetch time (Part 1)
- Attachment manifest (filename, size, MIME type) returned alongside body in Part 2 — no extra request needed to render the attachment list

---

## Part 4 — Local FlexSearch Index

### Index configuration

```typescript
// Illustrative — consult FlexSearch v0.7 API for exact Document constructor signature.
// tokenize and encoder options nest inside field descriptors in Document indexes.
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

### Build strategy

- Index built **incrementally** as metadata arrives over SSE — each batch adds to the index, no full rebuild
- Debounced persistence: `index.export()` snapshot written to Dexie `searchIndex` every 500 new emails added, not on every insert
- On app start: rehydrate index from Dexie snapshot before first search — fully offline after initial backfill

### Search flow

1. Query hits local FlexSearch index — returns matching `id`s
2. IDs looked up in Dexie `emails` for display
3. If zero local results **and** `syncState.backfillComplete` is `false`: fallback live IMAP search via Elysia (exception not the rule)
4. If zero local results **and** `syncState.backfillComplete` is `true`: display empty results (no fallback — backfill is complete, email genuinely not in history)

### Storage

- FlexSearch in-memory: ~15–25MB for 100k emails across 4 fields
- Dexie snapshot: ~8–12MB serialised

### Future: full-text body search

Out of scope for this branch. When added: a separate FlexSearch index over Dexie `bodies` (cached bodies only), searched after metadata index. Bodies not in cache fall back to Elysia IMAP `SEARCH TEXT` command.

---

## Jazz Elimination

| Jazz feature | Replacement |
|---|---|
| `JazzMessage` (email cache) | Dexie `emails` table |
| `JazzInboxState.messages` | Dexie queries |
| `JazzInboxState.folders` | Fetched from Elysia on demand |
| `JazzInboxState.mailboxes` | Turso `mailboxes` table (existing) |
| `JazzInboxState.senderRules` | Turso `user_state` table |
| `JazzInboxState.recentSearches` | Dexie (device-local only — deliberate downgrade from cross-device sync) |
| Snooze / archive / reply status | Turso `user_state` table (shared across devices) |
| `jazz-provider.tsx` | Deleted |

---

## Commit Plan

```
feat: extract IMAP to Elysia service + BetterAuth wiring
feat: metadata-first sync schema (Dexie + EmailMetadata + SSE stream)
feat: lazy body fetching with cache eviction
feat: attachment streaming
feat: local metadata search index (FlexSearch)
```

> Note: 5 commits — the Elysia extraction is a standalone commit preceding the original four.

---

## Environment Variables

### Next.js (additions)
```
ELYSIA_SERVICE_URL        # e.g. https://mail.yourdomain.com
ELYSIA_SERVICE_SECRET     # shared secret for Next.js → Elysia REST proxy auth
```

### Elysia service (new)
```
TURSO_DATABASE_URL
TURSO_AUTH_TOKEN
IMAP_HOST
IMAP_PORT
IMAP_SECURE
ELYSIA_SERVICE_SECRET     # validates inbound REST requests from Next.js
BETTERAUTH_SECRET         # validates BetterAuth session tokens on SSE/WebSocket connections
CORS_ORIGIN               # Next.js origin, e.g. https://yourdomain.com
```
