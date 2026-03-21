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

**Jazz**: eliminated entirely. User state (snooze, archive, reply status, sender rules) migrates to Turso.

---

## Architecture Diagram

```
Browser
  └── Next.js (Vercel)
        ├── BetterAuth session validation
        ├── Proxy routes → Elysia service
        └── Dexie (IndexedDB, encrypted)
              ├── emails table (EmailMetadata)
              ├── bodies table (body cache)
              ├── searchIndex table (FlexSearch snapshot)
              └── syncState table (cursors + watermarks)

Elysia service (Bun, Railway / Fly.io / self-hosted)
  ├── IMAP IDLE daemon (per mailbox)
  ├── SSE endpoint → streams metadata batches to browser
  ├── WebSocket endpoint → pushes real-time delta events
  ├── GET /body/:emailId → streams body from IMAP
  └── GET /attachments/:emailId/:attachmentId → streams attachment

Turso / libsql
  ├── mailboxes (existing)
  ├── oauth_states (existing)
  ├── scheduled_emails (existing)
  ├── user_profiles (existing)
  └── user_state (NEW: snooze, archive, reply_status, sender_rules)
```

---

## Authentication

The Elysia service is **not publicly exposed**. All browser requests go through Next.js proxy routes. Next.js validates the BetterAuth session, then forwards to Elysia with a shared service secret (`ELYSIA_SERVICE_SECRET` env var). Elysia rejects any request without this header.

This keeps Elysia off the public internet and decouples browser auth from service auth.

---

## Part 1 — Metadata-First Sync

### EmailMetadata type

```typescript
type EmailMetadata = {
  id: string;           // IMAP UID (string for cross-provider compat)
  threadId: string;     // X-GM-THRID (Gmail only, empty string otherwise)
  subject: string;
  fromName: string;
  fromAddress: string;
  date: number;         // Unix timestamp ms
  snippet: string;      // First 200 chars, plain text, HTML stripped
  isRead: boolean;      // \Seen IMAP flag
  isStarred: boolean;   // \Flagged IMAP flag
  labels: string[];     // X-GM-LABELS (Gmail only, empty array otherwise)
  hasAttachments: boolean; // Derived from bodyStructure during metadata fetch
};
```

### Dexie schema

```
emails:        ++id, date, fromAddress, isRead, threadId
bodies:        id, lastAccessed, byteSize, compressed
searchIndex:   field, snapshot
syncState:     key, value   (backfillCursor, watermarkUid, lastSyncAt)
```

`emails` indexed on `date`, `fromAddress`, `isRead`, `threadId` for fast filter queries.

### Sync flow

**Initial load (eager, 500 emails):**
1. Browser opens SSE connection to `/api/mail/stream` → proxied to Elysia
2. Elysia fetches latest 500 UIDs from IMAP INBOX, fetches envelope + flags + bodyStructure per message
3. Streams batches of 50 as SSE `data:` events
4. Browser writes each batch to Dexie `emails` table
5. UI renders from Dexie — inbox visible within the first batch (~50 emails, <2s)

**Background backfill (progressive, remaining history):**
1. SSE stream continues after initial 500
2. Elysia works backwards by UID in batches of 200
3. Browser writes batches to Dexie via `requestIdleCallback` to avoid UI jank
4. `syncState.backfillCursor` tracks lowest UID reached — resumes from cursor if interrupted
5. Backfill completes when cursor reaches UID 1 or the mailbox beginning

**Storage estimate:** ~1–1.5KB per email row (envelope + snippet + indices). 100k emails ≈ **100–150MB** — well within 500MB target.

### IMAP delta events (real-time updates)

Elysia maintains an IMAP IDLE connection per mailbox (INBOX only). Other folders polled every 5 minutes.

| IMAP event | Elysia action | Browser action |
|---|---|---|
| `EXISTS` | Fetch new message metadata | Upsert into Dexie, add to FlexSearch |
| `EXPUNGE` | Send delete event with UID | Delete from Dexie `emails` + `bodies` |
| `FETCH` (flags) | Send flag-update event | Patch `isRead` / `isStarred` in Dexie |

Events are pushed over WebSocket. Browser applies patches to Dexie; UI reactively updates.

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

1. Hook checks Dexie `bodies` table first — if hit, decompress and return immediately (no network)
2. On cache miss: fetch `/api/mail/body/:id` → proxied to Elysia
3. Elysia fetches full body from IMAP (HTML preferred, plain text fallback), parses `bodyStructure` for attachment manifest (filename, size, MIME type — no content)
4. Returns body + attachment manifest
5. Browser compresses body via `CompressionStream` (60–70% reduction), writes to Dexie with `lastAccessed = now`, `byteSize` = compressed size

### Eviction policy

Runs on **every body write** and on **app startup**:

- **Size-based (primary)**: `syncState.totalBodyBytes` maintained as a running counter. If counter exceeds `MAX_BODY_CACHE_MB` (default 500MB), evict LRU bodies (sorted by `lastAccessed` asc) until under limit.
- **Time-based (secondary)**: on app startup, delete all bodies where `lastAccessed < now - 30 days`.
- Metadata record in `emails` table is **never evicted** — only the body entry is removed.

### Performance penalties

| Penalty | Impact | Mitigation |
|---|---|---|
| Cold open latency | 200–800ms IMAP round-trip on first open | Prefetch body of topmost unread email in viewport |
| Large emails | Single 500KB newsletter = 0.1% of cache | `byteSize` tracked; oversized bodies (>5MB) not cached |
| Eviction cost | LRU sort on every write | Running counter avoids full table scan; only sort when over limit |

---

## Part 3 — Attachment Streaming

### Server (Elysia)

`GET /attachments/:emailId/:attachmentId`

1. Fetch `bodyStructure` from IMAP (cached from body fetch if available)
2. Locate attachment part by `attachmentId` (MIME part path)
3. Stream part directly as `ReadableStream` with correct `Content-Type` and `Content-Disposition: inline` or `attachment` headers
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
- Attachment manifest (filename, size, MIME type) returned alongside body in Part 2 — no extra request needed

---

## Part 4 — Local FlexSearch Index

### Index configuration

```typescript
const index = new Document({
  document: {
    id: 'id',
    index: ['subject', 'fromName', 'fromAddress', 'snippet'],
  },
  tokenize: 'forward',
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
3. If zero local results and backfill is incomplete: fallback live IMAP search via Elysia (same as current behaviour, now the exception not the rule)

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
| `JazzInboxState.recentSearches` | Dexie (local only, no sync needed) |
| Snooze / archive / reply status | Turso `user_state` table |
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

> Note: 5 commits, not 4 — the Elysia extraction is a standalone commit preceding the original four.

---

## Environment Variables

### Next.js (additions)
```
ELYSIA_SERVICE_URL        # e.g. https://mail.yourdomain.com
ELYSIA_SERVICE_SECRET     # shared secret for service-to-service auth
```

### Elysia service (new)
```
TURSO_DATABASE_URL
TURSO_AUTH_TOKEN
IMAP_HOST
IMAP_PORT
IMAP_SECURE
ELYSIA_SERVICE_SECRET
BETTERAUTH_SECRET
```

---

## Open Questions

- Should the Elysia service maintain one IMAP connection per mailbox concurrently, or multiplex? (Relevant for users with multiple Gmail accounts — Gmail allows up to 15 concurrent IMAP connections per account.)
- Should `user_state` in Turso be per-device or shared across devices? (Snooze should sync; local UI preferences should not.)
