# BetterAuth Migration — Design Spec

**Date:** 2026-03-21
**Branch:** `feat/auth-betterauth`
**Replaces:** Clerk (`@clerk/nextjs`)
**Must land before:** `feat/tiered-sync`

---

## Overview

Replace Clerk with BetterAuth across the Next.js app. Auth methods: email + password, Google OAuth (social sign-in to xedmail), and magic link via Resend. Wire the existing Jazz provider to BetterAuth using Jazz-tools' built-in BetterAuth plugin. Drop and recreate the Turso schema, renaming `clerk_user_id` to `user_id` throughout.

---

## Auth Methods

| Method | Plugin | Notes |
|---|---|---|
| Email + password | `emailAndPassword()` | Sign-up mode toggle on login page |
| Google OAuth | `socialProviders.google` | Reuses existing `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` |
| Magic link | `magicLink()` | Email sent via Resend; `RESEND_API_KEY` placeholder until production |

---

## Architecture

```
Browser
  ├── src/lib/auth-client.ts    → createAuthClient (useSession, signIn, signOut)
  └── src/app/login/page.tsx    → sign-in UI (Google, email+pw, magic link)

Next.js
  ├── src/middleware.ts         → session check, redirect to /login or 401
  ├── src/app/api/auth/[...all]/route.ts  → BetterAuth catch-all handler
  ├── src/lib/auth.ts           → BetterAuth server instance (libsql adapter)
  └── src/lib/api-auth.ts       → requireUserId() helper for API routes

Turso (libsql)
  ├── user               ← BetterAuth-managed
  ├── session            ← BetterAuth-managed
  ├── account            ← BetterAuth-managed
  ├── verification       ← BetterAuth-managed
  ├── user_profiles      ← app-managed, user_id FK
  ├── mailboxes          ← app-managed, user_id FK
  ├── oauth_states       ← app-managed, user_id FK
  └── scheduled_emails   ← app-managed, user_id FK
```

---

## File Changes

### New files

| File | Purpose |
|---|---|
| `src/lib/auth.ts` | BetterAuth server instance — libsql adapter, plugins, Google provider |
| `src/lib/auth-client.ts` | BetterAuth browser client — `useSession`, `signIn`, `signOut` |
| `src/app/api/auth/[...all]/route.ts` | Catch-all route handler for all BetterAuth HTTP endpoints |
| `src/app/login/page.tsx` | Sign-in UI — Google button, email+pw form, magic link option |
| `src/middleware.ts` | Replaces `proxy.ts` — session-based route protection |

### Modified files

| File | Change |
|---|---|
| `src/lib/db.ts` | Drop `clerk_user_id` column; add `user_id` FK to app tables |
| `src/lib/mail-store.ts` | Update all SQL queries: `clerk_user_id` → `user_id` |
| `src/lib/api-auth.ts` | Replace `requireClerkUserId()` with `requireUserId()` using BetterAuth session |
| `src/app/layout.tsx` | Remove `ClerkProvider`; no replacement provider needed |
| `src/app/page.tsx` | Replace `useAuth`, `useUser` with `useSession` |
| `src/app/inbox/page.tsx` | Replace `useAuth` with `useSession` |
| `src/components/app-sidebar.tsx` | Replace `currentUser()` with BetterAuth server session |
| `src/providers/jazz-provider.tsx` | Replace `JazzClerkAuth` with Jazz BetterAuth plugin |
| `src/components/inbox/inbox-client.tsx` | Replace `useAuth`/`useUser` with `useSession`; remove all `getToken()` calls (see note below) |
| `package.json` | Add `better-auth`, `@better-auth/libsql`, `resend`; remove `@clerk/nextjs` |
| `proxy.ts` | **Delete** — replaced by `middleware.ts` |

---

## BetterAuth Server (`src/lib/auth.ts`)

```typescript
import { betterAuth } from "better-auth";
import { libsqlClient } from "@better-auth/libsql";
import { emailAndPassword, magicLink } from "better-auth/plugins";

export const auth = betterAuth({
  database: libsqlClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN,
  }),
  emailAndPassword: { enabled: true },
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    },
  },
  plugins: [
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        // Resend integration — stub logs to console if RESEND_API_KEY not set
        if (!process.env.RESEND_API_KEY) {
          console.log(`[magic-link] ${email}: ${url}`);
          return;
        }
        const { Resend } = await import("resend");
        const resend = new Resend(process.env.RESEND_API_KEY);
        await resend.emails.send({
          from: process.env.RESEND_FROM_EMAIL!, // e.g. "noreply@yourdomain.com"
          to: email,
          subject: "Sign in to June",
          html: `<a href="${url}">Click here to sign in</a>`,
        });
      },
    }),
  ],
});

export type Session = typeof auth.$Infer.Session;
```

---

## BetterAuth Client (`src/lib/auth-client.ts`)

```typescript
import { createAuthClient } from "better-auth/react";
import { magicLinkClient } from "better-auth/client/plugins";

export const { useSession, signIn, signUp, signOut } = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_BETTER_AUTH_URL ?? "",
  plugins: [magicLinkClient()],
});
```

---

## Middleware (`src/middleware.ts`)

- Reads session token from cookies via BetterAuth's `auth.api.getSession`
- Unprotected paths: `/login`, `/api/auth/(.*)`, `/_next/(.*)`, static assets (images, fonts, etc.)
- **Protected page routes:** `/` (home), `/inbox`, `/settings` and any sub-paths — redirect unauthenticated requests to `/login`
- **Protected API routes** (non-auth, e.g. `/api/mail/(.*)`): return `401 { error: "UNAUTHORIZED" }` as JSON
- Replaces `proxy.ts` entirely; `proxy.ts` is deleted

---

## API Auth Helper (`src/lib/api-auth.ts`)

```typescript
import { auth } from "@/lib/auth";
import { headers } from "next/headers";

export async function requireUserId(): Promise<string> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.id) throw new Error("UNAUTHORIZED");
  return session.user.id;
}
```

All API routes call `requireUserId()` — no other changes needed.

**Removing `getToken()` calls:** The existing client files (`page.tsx`, `inbox/page.tsx`, `inbox-client.tsx`) call `getToken()` from `useAuth()` and pass `Authorization: Bearer <token>` on every fetch. BetterAuth authenticates via cookies (httpOnly), not bearer tokens. The API routes already validate via `requireUserId()` on the server side using cookies — the `Authorization` header is never checked. Therefore: **remove all `getToken()` calls and `Authorization: Bearer` headers** from every client file. No replacement is needed; the server-side cookie validation is sufficient.

---

## Database Schema

BetterAuth auto-creates its four tables (`user`, `session`, `account`, `verification`) on first boot via the libsql adapter.

App tables are recreated in `src/lib/db.ts` with `user_id` replacing `clerk_user_id`.

**`user_profiles` creation:** A row is upserted into `user_profiles` on every successful sign-in, using a BetterAuth `onSession` or `onSignIn` hook in `auth.ts`. This ensures the FK constraint in `mailboxes` is always satisfied before a mailbox is added. The `user_id` value is the BetterAuth `user.id`.

**`scheduled_emails`**: No FK to `user_profiles` — intentional. The scheduler is a background worker that may run after a user is deleted; a hard FK would block cleanup. `user_id` is still stored for filtering.

```sql
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id TEXT PRIMARY KEY,
  display_name TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mailboxes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  email_address TEXT NOT NULL,
  image TEXT,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  access_token_expires_at INTEGER,
  scopes TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  last_sync_at INTEGER,
  provider_metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, provider, email_address),
  FOREIGN KEY (user_id) REFERENCES user_profiles(user_id)
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scheduled_emails (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  mailbox_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  in_reply_to TEXT,
  "references" TEXT,
  send_at INTEGER NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0,
  sending INTEGER NOT NULL DEFAULT 0
);
```

---

## Sign-in Page (`src/app/login/page.tsx`)

Single page, three sign-in options, dark theme matching existing UI:

1. **Google** — "Continue with Google" button → `signIn.social({ provider: "google", callbackURL: "/" })`
2. **Email + password** — form with email/password fields; toggle between Sign In and Sign Up mode; calls `signIn.email()` or `signUp.email()`
3. **Magic link** — "Email me a sign-in link" option below the form; calls `signIn.magicLink({ email, callbackURL: "/" })`

No separate `/signup` route — sign-up is a mode toggle on `/login`. After successful auth, Next.js redirects to `/`.

---

## Jazz Provider Update (`src/providers/jazz-provider.tsx`)

Jazz-tools ships a BetterAuth plugin. The confirmed export paths (verified against `node_modules/jazz-tools/package.json`) are:

- `jazz-tools/better-auth/auth/client` → exports `jazzPluginClient`
- `jazz-tools/better-auth/auth/react` → exports `AuthProvider`

Replace in `jazz-provider.tsx`:

```typescript
// Before
import { useClerk, useUser } from "@clerk/nextjs";
import { JazzClerkAuth } from "jazz-tools";
// ...
const auth = new JazzClerkAuth(useClerk(), useUser());

// After — add jazzPluginClient() to createAuthClient plugins:
import { jazzPluginClient } from "jazz-tools/better-auth/auth/client";
import { AuthProvider } from "jazz-tools/better-auth/auth/react";
// auth-client.ts must include jazzPluginClient() in its plugins array

// In provider: wrap JazzProvider children with AuthProvider:
<AuthProvider betterAuthClient={authClient}>
  {children}
</AuthProvider>
```

`src/lib/auth-client.ts` must include `jazzPluginClient()` as a plugin:

```typescript
import { jazzPluginClient } from "jazz-tools/better-auth/auth/client";

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_BETTER_AUTH_URL ?? "",
  plugins: [magicLinkClient(), jazzPluginClient()],
});
export const { useSession, signIn, signUp, signOut } = authClient;
```

The provider structure (peer, sync, `JazzProvider` wrapper) stays identical.

---

## Environment Variables

### Remove
```
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
CLERK_SECRET_KEY
```

### Add
```
BETTER_AUTH_SECRET          # random string, min 32 chars — signs sessions
BETTER_AUTH_URL             # e.g. http://localhost:3000
NEXT_PUBLIC_BETTER_AUTH_URL # same value, exposed to browser
RESEND_API_KEY              # placeholder — magic link email (console fallback if unset)
RESEND_FROM_EMAIL           # e.g. noreply@yourdomain.com — placeholder, required for production
```

### Keep (reused)
```
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
TURSO_DATABASE_URL
TURSO_AUTH_TOKEN
```

---

## Commit Plan

```
feat: add BetterAuth server instance + client + catch-all route
feat: replace Clerk middleware with BetterAuth session middleware
feat: add /login page (email+pw, Google, magic link)
feat: update Turso schema — clerk_user_id → user_id
feat: replace Clerk hooks in app components
feat: wire Jazz provider to BetterAuth
chore: remove Clerk dependency
```
