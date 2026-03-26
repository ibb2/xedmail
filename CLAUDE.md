# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

xedmail is a search-first email client (inspired by Superhuman/Spark) built with Next.js 15 and React 19. It connects to Gmail via IMAP/OAuth, uses Dexie (IndexedDB) with FlexSearch for encrypted client-side state, synced from a standalone Elysia mail service, and optionally uses a Python NLP microservice for natural language search query parsing.

## Commands

### Web App (`web/xedmail/`)
```bash
npm run dev      # Dev server with Turbopack
npm run build    # Production build
npm run lint     # Biome linter
npm run format   # Biome formatter
```

### Elysia Mail Service (`services/mail/`)
```bash
bun run dev          # Dev server (port 3001) with file watching
bun run start        # Production
bun run db:generate  # Generate Drizzle migrations
bun run db:migrate   # Apply migrations
```

### Python NLP Microservice (`ms/`)
```bash
python -m uvicorn main:app --reload   # Dev server on :8000
```
Requires Python 3.12+ and `pip install -e .` (or equivalent). Uses SpaCy with `en_core_web_sm` model.

## Architecture

### Request Flow

```
Browser → Next.js App Router
  → API Routes (/api/mail/*)
    → Elysia Mail Service (:3001) — IMAP daemon, SSE/WebSocket sync
      → ImapFlow (Gmail IMAP via OAuth)
      → Turso SQLite (mailbox/token storage)
    → Python NLP service (optional, :8000/parse)
  → Dexie (IndexedDB) — local email cache with FlexSearch index
```

### Key Layers

**Authentication**: BetterAuth handles user auth (`src/lib/auth.ts` server, `src/lib/auth-client.ts` browser client). Auth methods: email+password, Google OAuth social sign-in, magic link via Resend. Session validated server-side via cookies in `src/middleware.ts` and `src/lib/api-auth.ts`. Google OAuth 2.0 also manages per-mailbox Gmail credentials stored in Turso. Token refresh logic lives in `src/lib/mail-auth.ts`.

**Email fetching**: The Elysia service (`services/mail/`) runs a persistent IMAP daemon connecting ImapFlow to `imap.gmail.com:993`. It streams new messages to the browser via SSE (`/stream`) and WebSocket (`/events`). The Next.js app proxies Elysia API calls through `/api/mail/*` routes.

**Search parsing**: `src/lib/mail-query.ts` sends the query to the Python service with a 3-second timeout, falling back to regex parsing if unavailable.

**State management**: `SyncProvider` (`src/providers/sync-provider.tsx`) wraps the app. It syncs email data from the Elysia service into a Dexie (IndexedDB) database with a FlexSearch index for fast local search. `useInboxState` (in `src/hooks/`) exposes `messages`, `folders`, `mailboxes`, and sync status.

**Database**: Turso SQLite is accessed by the Elysia service. `src/lib/db.ts` (Next.js side) handles auth-related tables: `user_profiles`, `mailboxes`, `oauth_states`. The Elysia service uses Drizzle ORM with its own schema in `services/mail/src/db/`.

### Directory Structure

```
web/xedmail/src/
├── app/
│   ├── page.tsx           # Search-first homepage
│   ├── layout.tsx         # Root layout (SyncProvider wraps app)
│   ├── inbox/page.tsx     # Inbox powered by Dexie + FlexSearch
│   ├── settings/          # Account management
│   └── api/mail/          # Proxy routes to Elysia service
├── components/
│   ├── ui/                # Radix UI / shadcn-style primitives
│   └── inbox/             # Inbox-specific components
├── hooks/                 # useInboxState, useEmailBody, etc.
├── lib/                   # mail-query.ts, mail-store.ts, db.ts, dexie.ts, flexsearch.ts, ...
└── providers/             # sync-provider.tsx

services/mail/
├── src/
│   ├── index.ts           # Elysia app entry point (port 3001)
│   ├── routes/            # stream.ts, events.ts, search.ts, body.ts, mailboxes.ts, ...
│   ├── imap/              # IMAP daemon — connection pool, idle listeners
│   ├── db/                # Drizzle schema + migrations (Turso)
│   └── middleware/        # Auth (ELYSIA_SERVICE_SECRET), CORS
└── .env                   # Local env (gitignored)

ms/
└── main.py                # FastAPI NLP service (SpaCy Matcher)
```

## Environment Variables

Required in `web/xedmail/.env.local`:
```
BETTER_AUTH_SECRET           # random string min 32 chars — signs sessions (openssl rand -base64 32)
BETTER_AUTH_URL              # e.g. http://localhost:3000
NEXT_PUBLIC_BETTER_AUTH_URL  # same value, exposed to browser
TURSO_DATABASE_URL
TURSO_AUTH_TOKEN
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REDIRECT_URI          # e.g. http://localhost:3000/api/mail/oauth/callback
IMAP_HOST                    # imap.gmail.com
IMAP_PORT                    # 993
IMAP_SECURE                  # true
IMAP_INBOX_NAME              # INBOX
ELYSIA_SERVICE_URL           # e.g. http://localhost:3001
ELYSIA_SERVICE_SECRET        # shared secret — must match services/mail/.env
NEXT_PUBLIC_ELYSIA_SERVICE_URL  # same as ELYSIA_SERVICE_URL, exposed to browser
```

Optional:
```
RESEND_API_KEY               # Magic link email via Resend (console fallback if unset)
RESEND_FROM_EMAIL            # e.g. noreply@yourdomain.com
MS_PARSER_URL                # Default: http://127.0.0.1:8000/parse
```

Required in `services/mail/.env`:
```
TURSO_DATABASE_URL           # same as web/xedmail/.env.local
TURSO_AUTH_TOKEN             # same as web/xedmail/.env.local
ELYSIA_SERVICE_SECRET        # shared secret — must match web/xedmail/.env.local
CORS_ORIGIN                  # e.g. http://localhost:3000
PORT                         # 3001
```

## Key Conventions

- Path alias `@/*` maps to `src/*`
- Linting/formatting via Biome (2-space indent); not ESLint/Prettier
- API routes export `runtime = "nodejs"` (required for ImapFlow/Turso)
- All IMAP operations use try-finally to ensure `imap.logout()` is called
- `ensureValidMailboxToken()` must be called before any IMAP operation — it refreshes the OAuth token if within 15 seconds of expiry
