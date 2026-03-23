# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

xedmail is a search-first email client (inspired by Superhuman/Spark) built with Next.js 15 and React 19. It connects to Gmail via IMAP/OAuth, uses Jazz-Tools for encrypted client-side state sync, and optionally uses a Python NLP microservice for natural language search query parsing.

## Commands

### Web App (`web/xedmail/`)
```bash
npm run dev      # Dev server with Turbopack
npm run build    # Production build
npm run lint     # Biome linter
npm run format   # Biome formatter
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
    → ImapFlow (Gmail IMAP via OAuth)
    → Turso SQLite (mailbox/token storage)
    → Python NLP service (optional, :8000/parse)
  → Jazz-Tools (local encrypted CRDT state)
```

### Key Layers

**Authentication**: BetterAuth handles user auth (`src/lib/auth.ts` server, `src/lib/auth-client.ts` browser client). Auth methods: email+password, Google OAuth social sign-in, magic link via Resend. Session validated server-side via cookies in `src/middleware.ts` and `src/lib/api-auth.ts`. Google OAuth 2.0 also manages per-mailbox Gmail credentials stored in Turso. Token refresh logic lives in `src/lib/mail-auth.ts`.

**Email fetching**: `src/lib/imap.ts` connects ImapFlow to `imap.gmail.com:993`. The inbox polls `/api/mail/search` every 30 seconds with debouncing via `isFetchingRef`.

**Search parsing**: `src/lib/mail-query.ts` sends the query to the Python service with a 3-second timeout, falling back to regex parsing if unavailable.

**State management**: `src/providers/jazz-provider.tsx` wraps the app. `JazzInboxContext` (in `src/hooks/`) exposes `messages`, `folders`, `mailboxes`, and `syncInbox()`. Jazz schema (CoMap/CoList types) is defined in `src/lib/jazz-schema.ts`.

**Database**: `src/lib/db.ts` auto-creates the Turso schema: `user_profiles`, `mailboxes`, `oauth_states`. Queries are in `src/lib/mail-store.ts`.

### Directory Structure

```
web/xedmail/src/
├── app/
│   ├── page.tsx           # Search-first homepage
│   ├── layout.tsx         # Root layout (JazzProvider wraps app)
│   ├── inbox/page.tsx     # Inbox with 30s polling
│   ├── settings/          # Account management
│   └── api/mail/          # search/, oauth/, mailboxes/ routes
├── components/
│   ├── ui/                # Radix UI / shadcn-style primitives
│   └── inbox/             # Inbox-specific components
├── hooks/                 # useJazzInboxState, etc.
├── lib/                   # imap.ts, mail-query.ts, mail-store.ts, db.ts, ...
└── providers/             # jazz-provider.tsx

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
```

Optional:
```
RESEND_API_KEY               # Magic link email via Resend (console fallback if unset)
RESEND_FROM_EMAIL            # e.g. noreply@yourdomain.com
NEXT_PUBLIC_JAZZ_SYNC_PEER   # WebSocket URL for cross-device Jazz sync
MS_PARSER_URL                # Default: http://127.0.0.1:8000/parse
```

## Key Conventions

- Path alias `@/*` maps to `src/*`
- Linting/formatting via Biome (2-space indent); not ESLint/Prettier
- API routes export `runtime = "nodejs"` (required for ImapFlow/Turso)
- All IMAP operations use try-finally to ensure `imap.logout()` is called
- `ensureValidMailboxToken()` must be called before any IMAP operation — it refreshes the OAuth token if within 15 seconds of expiry
