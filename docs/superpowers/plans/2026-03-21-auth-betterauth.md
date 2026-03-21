# BetterAuth Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Clerk with BetterAuth (email+password, Google OAuth, magic link via Resend) across the Next.js app, wire Jazz to BetterAuth, and remove the `@clerk/nextjs` dependency.

**Architecture:** BetterAuth server instance at `src/lib/auth.ts` uses the existing `@libsql/client` (already installed) as its database adapter. The browser client at `src/lib/auth-client.ts` uses `createAuthClient` and includes the Jazz plugin so Jazz-tools can wire itself to BetterAuth sessions. All Clerk providers, hooks, and server functions are replaced 1:1 with BetterAuth equivalents. The `proxy.ts` middleware is deleted and replaced with `middleware.ts`.

**Tech Stack:** BetterAuth 1.x, better-auth/react, Resend (magic links), jazz-tools BetterAuth plugin (`jazz-tools/better-auth/auth/client` + `jazz-tools/better-auth/auth/react`), Next.js 16.2, Turso/libsql, TypeScript, Bun

---

## Pre-flight checks

- [ ] Confirm you are on a new branch: `git checkout -b feat/auth-betterauth`
- [ ] Run `cd web/xedmail && bun run dev` — confirm the app currently boots with Clerk before touching anything

---

## File Map

### New files

| File | Purpose |
|---|---|
| `web/xedmail/src/lib/auth.ts` | BetterAuth server instance — libsql adapter, Google, email+pw, magic link, user_profiles upsert |
| `web/xedmail/src/lib/auth-client.ts` | BetterAuth browser client — `useSession`, `signIn`, `signOut`, Jazz plugin |
| `web/xedmail/src/app/api/auth/[...all]/route.ts` | BetterAuth catch-all route handler |
| `web/xedmail/src/app/login/page.tsx` | Sign-in UI — Google, email+pw (sign in / sign up toggle), magic link |
| `web/xedmail/src/middleware.ts` | Session-based route protection, replaces `proxy.ts` |

### Modified files

| File | Change |
|---|---|
| `web/xedmail/src/lib/db.ts` | Rename `clerk_user_id` → `user_id` in all `CREATE TABLE` statements |
| `web/xedmail/src/lib/mail-store.ts` | Rename `clerkUserId` params → `userId`, `clerk_user_id` SQL → `user_id` |
| `web/xedmail/src/lib/api-auth.ts` | Replace `requireClerkUserId()` with `requireUserId()` using BetterAuth session |
| `web/xedmail/src/app/layout.tsx` | Remove `ClerkProvider` wrapper |
| `web/xedmail/src/app/page.tsx` | Replace `useAuth`/`useUser` with `useSession`; remove `getToken()` and `Authorization` headers |
| `web/xedmail/src/app/inbox/page.tsx` | Replace `useAuth` with `useSession`; remove `getToken()` and `Authorization` headers |
| `web/xedmail/src/components/app-sidebar.tsx` | Replace `currentUser()` with BetterAuth `auth.api.getSession` |
| `web/xedmail/src/components/nav-user.tsx` | Wire "Log out" `DropdownMenuItem` to `signOut()` |
| `web/xedmail/src/components/inbox/inbox-client.tsx` | Remove `useAuth`/`useUser` imports; remove all `getToken()` calls and `Authorization: Bearer` headers |
| `web/xedmail/src/providers/jazz-provider.tsx` | Replace `JazzClerkAuth`/`RegisterClerkAuth`/`initializeClerkAuth` with `AuthProvider` from `jazz-tools/better-auth/auth/react` |
| `web/xedmail/package.json` | Add `better-auth`, `resend`; remove `@clerk/nextjs` |

### Deleted files

| File | Reason |
|---|---|
| `web/xedmail/src/proxy.ts` | Replaced by `src/middleware.ts` |

---

## Task 1: Update Turso schema — clerk_user_id → user_id

**Commit:** `feat: update Turso schema — clerk_user_id → user_id`

**Files:**
- Modify: `web/xedmail/src/lib/db.ts`
- Modify: `web/xedmail/src/lib/mail-store.ts`
- Modify: `web/xedmail/src/lib/mail-types.ts`
- Modify: `web/xedmail/src/lib/mail-auth.ts`

---

- [ ] **Step 1: Rewrite `ensureDatabaseSchema` in `src/lib/db.ts`**

Replace the full `ensureDatabaseSchema` function body with these tables (`clerk_user_id` → `user_id` everywhere):

```typescript
export async function ensureDatabaseSchema(): Promise<void> {
  if (initialized) return;

  const db = getDbClient();

  await db.batch(
    [
      `CREATE TABLE IF NOT EXISTS user_profiles (
        user_id TEXT PRIMARY KEY,
        display_name TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );`,
      `CREATE TABLE IF NOT EXISTS mailboxes (
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
      );`,
      `CREATE TABLE IF NOT EXISTS oauth_states (
        state TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );`,
      `CREATE TABLE IF NOT EXISTS scheduled_emails (
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
      );`,
    ],
    "write",
  );

  initialized = true;
}
```

- [ ] **Step 2: Update `src/lib/mail-store.ts` — rename all Clerk references**

This is a mechanical rename. Apply all of the following changes:

**TypeScript identifiers** (function params + type fields):
- All `clerkUserId` parameter names → `userId`
- Type field `clerkUserId: string` in `OAuthState` and `ScheduledEmailRecord` → `userId: string`

**SQL column names** (inside template literal strings):
- `clerk_user_id` → `user_id` (everywhere in SQL — INSERT, SELECT, WHERE, ON CONFLICT)

**Return object fields** (rowTo* mappers):
- `clerkUserId: String(row.clerk_user_id)` → `userId: String(row.user_id)` (appears in `rowToMailbox`, `rowToOAuthState`, `rowToScheduledEmail`)

After renaming, the `ensureUserProfile` function should look like:
```typescript
async function ensureUserProfile(userId: string): Promise<void> {
  const db = getDbClient();
  const now = Date.now();
  await db.execute({
    sql: `INSERT INTO user_profiles (user_id, created_at, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET updated_at = excluded.updated_at`,
    args: [userId, now, now],
  });
}
```

- [ ] **Step 3: Update `src/lib/mail-types.ts` — rename `clerkUserId` type fields**

`mail-types.ts` has `clerkUserId: string` at lines 5 and 42. Rename both to `userId: string`.

- [ ] **Step 4: Update `src/lib/mail-auth.ts` — rename `clerkUserId` params**

`mail-auth.ts` uses `clerkUserId` as a parameter name at lines 40 and 53. Rename both to `userId`. The two function calls at lines 43 and 55 pass the parameter to `mail-store.ts` functions — no other changes needed since those functions were already renamed in Step 2.

- [ ] **Step 5: Verify TypeScript compiles**

```bash
cd web/xedmail && bun run build 2>&1 | grep "error TS" | head -20
```

Expected: zero TypeScript errors. If errors mention `clerkUserId` it means a rename was missed — fix and re-run.

- [ ] **Step 6: Commit**

```bash
git add web/xedmail/src/lib/db.ts \
        web/xedmail/src/lib/mail-store.ts \
        web/xedmail/src/lib/mail-types.ts \
        web/xedmail/src/lib/mail-auth.ts
git commit -m "feat: update Turso schema — clerk_user_id → user_id"
```

---

## Task 2: BetterAuth server + client + catch-all route

**Commit:** `feat: add BetterAuth server instance + client + catch-all route`

**Files:**
- Create: `web/xedmail/src/lib/auth.ts`
- Create: `web/xedmail/src/lib/auth-client.ts`
- Create: `web/xedmail/src/app/api/auth/[...all]/route.ts`
- Modify: `web/xedmail/src/lib/api-auth.ts`
- Modify: `web/xedmail/package.json`

---

- [ ] **Step 1: Install BetterAuth and Resend**

```bash
cd web/xedmail && bun add better-auth resend
```

Expected: both packages added to `package.json` and `bun.lock` updated.

- [ ] **Step 2: Add env vars to `.env.local`**

Open `web/xedmail/.env.local` and append:

```bash
BETTER_AUTH_SECRET=           # generate: openssl rand -base64 32
BETTER_AUTH_URL=http://localhost:3000
NEXT_PUBLIC_BETTER_AUTH_URL=http://localhost:3000
RESEND_API_KEY=re_placeholder
RESEND_FROM_EMAIL=noreply@yourdomain.com
```

Generate a real `BETTER_AUTH_SECRET`:
```bash
openssl rand -base64 32
```

- [ ] **Step 3: Create `src/lib/auth.ts`**

BetterAuth's libsql adapter accepts a `@libsql/client` instance directly (already installed). The `user_profiles` row is upserted on every sign-in using BetterAuth's `databaseHooks` (fires after user creation):

```typescript
// web/xedmail/src/lib/auth.ts
import { betterAuth } from "better-auth";
import { createClient } from "@libsql/client";
import { magicLink } from "better-auth/plugins";

const dbClient = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

export const auth = betterAuth({
  database: {
    db: dbClient,
    type: "sqlite",
  },
  secret: process.env.BETTER_AUTH_SECRET!,
  baseURL: process.env.BETTER_AUTH_URL!,
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
        if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM_EMAIL) {
          console.log(`[magic-link] ${email}: ${url}`);
          return;
        }
        const { Resend } = await import("resend");
        const resend = new Resend(process.env.RESEND_API_KEY);
        await resend.emails.send({
          from: process.env.RESEND_FROM_EMAIL,
          to: email,
          subject: "Sign in to xedmail",
          html: `<p><a href="${url}">Click here to sign in</a></p>`,
        });
      },
    }),
  ],
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          const now = Date.now();
          await dbClient.execute({
            sql: `INSERT INTO user_profiles (user_id, created_at, updated_at)
                  VALUES (?, ?, ?)
                  ON CONFLICT(user_id) DO UPDATE SET updated_at = excluded.updated_at`,
            args: [user.id, now, now],
          });
        },
      },
    },
  },
});

export type Session = typeof auth.$Infer.Session;
```

**Note on database config:** Before writing this file, run:
```bash
cat web/xedmail/node_modules/better-auth/package.json | grep -A5 '"adapters"'
ls web/xedmail/node_modules/better-auth/dist/ | grep -i libsql
```
to confirm the correct adapter import path. The `{ db, type: "sqlite" }` pattern matches BetterAuth v1's documented sqlite approach. If it doesn't resolve, alternatives are: `database: dbClient` directly, or `import { libsqlAdapter } from "better-auth/adapters/libsql"`. Use whichever exists in the installed package.

- [ ] **Step 4: Create `src/lib/auth-client.ts`**

```typescript
// web/xedmail/src/lib/auth-client.ts
"use client";
import { createAuthClient } from "better-auth/react";
import { magicLinkClient } from "better-auth/client/plugins";
import { jazzPluginClient } from "jazz-tools/better-auth/auth/client";

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_BETTER_AUTH_URL ?? "",
  plugins: [magicLinkClient(), jazzPluginClient()],
});

export const { useSession, signIn, signUp, signOut } = authClient;
```

- [ ] **Step 5: Create `src/app/api/auth/[...all]/route.ts`**

BetterAuth provides a Next.js adapter. The `runtime = "nodejs"` export is required because the Turso client uses Node.js APIs.

```typescript
// web/xedmail/src/app/api/auth/[...all]/route.ts
export const runtime = "nodejs";

import { auth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";

export const { GET, POST } = toNextJsHandler(auth);
```

- [ ] **Step 6: Replace `src/lib/api-auth.ts`**

```typescript
// web/xedmail/src/lib/api-auth.ts
import { auth } from "@/lib/auth";
import { headers } from "next/headers";

export async function requireUserId(): Promise<string> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.id) {
    throw new Error("UNAUTHORIZED");
  }
  return session.user.id;
}
```

- [ ] **Step 7: Update all API route callers of `requireClerkUserId`**

Find every file that calls it:
```bash
grep -r "requireClerkUserId" web/xedmail/src/app/api --include="*.ts" -l
```

In each file, make two changes:
1. Change the import: `requireClerkUserId` → `requireUserId`
2. Change the call and variable name: `const clerkUserId = await requireClerkUserId()` → `const userId = await requireUserId()`
3. Update all subsequent uses of `clerkUserId` in the same file → `userId`

- [ ] **Step 8: Verify TypeScript compiles**

```bash
cd web/xedmail && bun run build 2>&1 | grep "error TS" | head -20
```

Expected: zero errors in auth files and API routes.

- [ ] **Step 9: Commit**

```bash
git add web/xedmail/src/lib/auth.ts \
        web/xedmail/src/lib/auth-client.ts \
        web/xedmail/src/app/api/auth \
        web/xedmail/src/lib/api-auth.ts \
        web/xedmail/package.json \
        web/xedmail/bun.lock
git commit -m "feat: add BetterAuth server instance + client + catch-all route"
```

---

## Task 3: Replace Clerk middleware with BetterAuth session middleware

**Commit:** `feat: replace Clerk middleware with BetterAuth session middleware`

**Files:**
- Create: `web/xedmail/src/middleware.ts`
- Delete: `web/xedmail/src/proxy.ts`

---

- [ ] **Step 1: Create `src/middleware.ts`**

```typescript
// web/xedmail/src/middleware.ts
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";

const PUBLIC_PREFIXES = ["/login", "/api/auth", "/_next/"];
const STATIC_EXT = /\.(html?|css|js|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)$/;

function isPublic(pathname: string): boolean {
  if (STATIC_EXT.test(pathname)) return true;
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));
}

function isApiRoute(pathname: string): boolean {
  return pathname.startsWith("/api/") && !pathname.startsWith("/api/auth");
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isPublic(pathname)) return NextResponse.next();

  const session = await auth.api.getSession({ headers: request.headers });

  if (!session) {
    if (isApiRoute(pathname)) {
      return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
    }
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
```

- [ ] **Step 2: Delete `src/proxy.ts`**

```bash
git rm web/xedmail/src/proxy.ts
```

- [ ] **Step 3: Verify build**

```bash
cd web/xedmail && bun run build 2>&1 | grep "error TS" | head -20
```

Expected: no errors.

- [ ] **Step 4: Commit**

The `git rm` in Step 2 already staged the `proxy.ts` deletion. Just add the new middleware:

```bash
git add web/xedmail/src/middleware.ts
git commit -m "feat: replace Clerk middleware with BetterAuth session middleware"
```

---

## Task 4: Add /login page

**Commit:** `feat: add /login page (email+pw, Google, magic link)`

**Files:**
- Create: `web/xedmail/src/app/login/page.tsx`

---

- [ ] **Step 1: Create `src/app/login/page.tsx`**

```typescript
// web/xedmail/src/app/login/page.tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";

type Mode = "signin" | "signup" | "magic";

const inputStyle: React.CSSProperties = {
  padding: "10px 14px",
  borderRadius: "0.75rem",
  background: "#0E0E0E",
  border: "1px solid rgba(82,68,57,0.4)",
  color: "#E5E2E1",
  fontSize: 14,
  fontFamily: "'Inter', sans-serif",
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
};

const submitStyle: React.CSSProperties = {
  padding: "10px 16px",
  borderRadius: "0.75rem",
  background: "linear-gradient(135deg, #FFB77B, #C8803F)",
  border: "none",
  color: "#4D2700",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: "'Inter', sans-serif",
  width: "100%",
};

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [magicSent, setMagicSent] = useState(false);
  const [loading, setLoading] = useState(false);

  const reset = (m: Mode) => {
    setMode(m);
    setError(null);
    setMagicSent(false);
  };

  const handleGoogle = async () => {
    setError(null);
    await authClient.signIn.social({ provider: "google", callbackURL: "/" });
  };

  const handleEmailPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (mode === "signup") {
        const res = await authClient.signUp.email({
          name,
          email,
          password,
          callbackURL: "/",
        });
        if (res.error) { setError(res.error.message ?? "Sign up failed"); return; }
      } else {
        const res = await authClient.signIn.email({
          email,
          password,
          callbackURL: "/",
        });
        if (res.error) { setError(res.error.message ?? "Sign in failed"); return; }
      }
      router.push("/");
    } finally {
      setLoading(false);
    }
  };

  const handleMagicLink = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      // magicLinkClient plugin adds signIn.magicLink at runtime
      const res = await (authClient.signIn as any).magicLink({
        email,
        callbackURL: "/",
      });
      if (res?.error) { setError(res.error.message ?? "Failed to send link"); return; }
      setMagicSent(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#131313",
        fontFamily: "'Inter', sans-serif",
        color: "#E5E2E1",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 400,
          padding: "40px 32px",
          background: "#1C1B1B",
          borderRadius: "1.5rem",
          border: "1px solid rgba(82,68,57,0.3)",
          display: "flex",
          flexDirection: "column",
          gap: 20,
        }}
      >
        <h1
          style={{
            fontFamily: "'Newsreader', serif",
            fontSize: 28,
            fontWeight: 400,
            margin: 0,
          }}
        >
          {mode === "signup" ? "Create account" : "Sign in"}
        </h1>

        {error && (
          <p style={{ color: "#FFB77B", fontSize: 13, margin: 0 }}>{error}</p>
        )}

        <button type="button" onClick={handleGoogle} style={{ ...submitStyle, background: "#2C2B2B", border: "1px solid rgba(82,68,57,0.4)", color: "#E5E2E1", fontWeight: 400 }}>
          Continue with Google
        </button>

        <div style={{ display: "flex", alignItems: "center", gap: 10, color: "rgba(216,195,180,0.4)", fontSize: 12 }}>
          <div style={{ flex: 1, height: 1, background: "rgba(82,68,57,0.3)" }} />
          or
          <div style={{ flex: 1, height: 1, background: "rgba(82,68,57,0.3)" }} />
        </div>

        <div style={{ display: "flex", gap: 6 }}>
          {(["signin", "signup", "magic"] as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => reset(m)}
              style={{
                flex: 1,
                padding: "6px 0",
                borderRadius: "0.5rem",
                background: mode === m ? "rgba(255,183,123,0.12)" : "transparent",
                border: mode === m ? "1px solid rgba(255,183,123,0.3)" : "1px solid rgba(82,68,57,0.3)",
                color: mode === m ? "#FFB77B" : "rgba(216,195,180,0.5)",
                fontSize: 11,
                cursor: "pointer",
                fontFamily: "'Inter', sans-serif",
              }}
            >
              {m === "signin" ? "Sign in" : m === "signup" ? "Sign up" : "Magic link"}
            </button>
          ))}
        </div>

        {(mode === "signin" || mode === "signup") && (
          <form onSubmit={handleEmailPassword} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {mode === "signup" && (
              <input type="text" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required style={inputStyle} />
            )}
            <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required style={inputStyle} />
            <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required style={inputStyle} />
            <button type="submit" disabled={loading} style={submitStyle}>
              {loading ? "…" : mode === "signup" ? "Create account" : "Sign in"}
            </button>
          </form>
        )}

        {mode === "magic" && !magicSent && (
          <form onSubmit={handleMagicLink} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required style={inputStyle} />
            <button type="submit" disabled={loading} style={submitStyle}>
              {loading ? "…" : "Email me a sign-in link"}
            </button>
          </form>
        )}

        {magicSent && (
          <p style={{ color: "rgba(216,195,180,0.7)", fontSize: 14, textAlign: "center", margin: 0 }}>
            Check your email — a sign-in link is on the way.
          </p>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify build**

```bash
cd web/xedmail && bun run build 2>&1 | grep "error TS" | head -20
```

Expected: no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add web/xedmail/src/app/login
git commit -m "feat: add /login page (email+pw, Google, magic link)"
```

---

## Task 5: Replace Clerk hooks in app components

**Commit:** `feat: replace Clerk hooks in app components`

**Files:**
- Modify: `web/xedmail/src/app/layout.tsx`
- Modify: `web/xedmail/src/app/page.tsx`
- Modify: `web/xedmail/src/app/inbox/page.tsx`
- Modify: `web/xedmail/src/components/app-sidebar.tsx`
- Modify: `web/xedmail/src/components/nav-user.tsx`
- Modify: `web/xedmail/src/components/inbox/inbox-client.tsx`
- Verify: `web/xedmail/src/app/home/page.tsx`

---

- [ ] **Step 1: Update `src/app/layout.tsx` — remove `ClerkProvider`**

Remove the `ClerkProvider` import and wrapper. The file becomes:

```typescript
import type { Metadata } from "next";
import "./globals.css";
import { JazzProvider } from "@/providers/jazz-provider";

export const metadata: Metadata = {
  title: "June",
  description: "A search-first email client",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;0,6..72,600;1,6..72,400&family=JetBrains+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200"
          rel="stylesheet"
        />
      </head>
      <body className="antialiased">
        <JazzProvider>{children}</JazzProvider>
      </body>
    </html>
  );
}
```

- [ ] **Step 2: Update `src/app/page.tsx` — replace Clerk hooks, remove getToken**

At the top of the file:
- Remove: `import { useAuth, useUser } from "@clerk/nextjs";`
- Add: `import { useSession } from "@/lib/auth-client";`

Inside the `Home` component:
- Remove: `const { getToken } = useAuth();`
- Remove: `const { user } = useUser();`
- Remove: `const firstName = user?.firstName ?? "there";`
- Add: `const { data: session } = useSession();`
- Add: `const firstName = session?.user?.name?.split(" ")[0] ?? "there";`

In `beginOauthFlow`:
- Remove: `const token = await getToken();`
- Remove the `headers: { Authorization: \`Bearer ${token}\` },` line from the fetch call

In `getMailboxes`:
- Remove: `const token = await getToken();`
- Remove the `headers: { Authorization: \`Bearer ${token}\` },` line from the fetch call

Around line 196, replace the user initial with session data:
- Change: `{(user?.firstName?.[0] ?? "U").toUpperCase()}`
- To: `{(session?.user?.name?.[0] ?? "U").toUpperCase()}`

- [ ] **Step 3: Update `src/app/inbox/page.tsx` — replace Clerk hook, remove getToken**

At the top:
- Remove: `import { useAuth } from "@clerk/nextjs";`
- Add: `import { useSession } from "@/lib/auth-client";`

Inside the `Inbox` component:
- Remove: `const { getToken } = useAuth();`
- Add: `const { data: _session } = useSession();` (kept for future use, or omit if unused)

In `getAllEmails` (the useCallback), remove every `getToken` call and the `Authorization` header. The three affected fetches become plain fetches:

```typescript
// Initial full fetch — was:
// const token = await getToken();
// headers: { Authorization: `Bearer ${token}` },
// After (remove those two lines; keep cache/signal):
const response = await fetch(
  `/api/mail/search?query=&includeFolders=${includeFolders}`,
  { cache: "no-store", signal: abortController.signal },
);

// Incremental UID fetch — same pattern: remove token + header
const response = await fetch(
  `/api/mail/new?minUid=${maxUid}&mailbox=${encodeURIComponent(mailboxAddress)}`,
  { cache: "no-store", signal: abortController.signal },
);

// Keyword IMAP search fallback — same pattern
const response = await fetch(
  `/api/mail/search?query=${encodeURIComponent(query)}&includeFolders=false`,
  { cache: "no-store", signal: abortController.signal },
);

// Scheduled emails fetch
const scheduledResponse = await fetch("/api/mail/scheduled", {
  signal: abortController.signal,
});
```

Update the `useCallback` dependency array on `getAllEmails` — remove `getToken` from `[getToken, query, intent, resurfaceSnoozedMessages]`.

- [ ] **Step 4: Update `src/components/app-sidebar.tsx` — replace `currentUser()`**

At the top:
- Remove: `import { currentUser } from "@clerk/nextjs/server";`
- Add:
```typescript
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
```

Replace the `currentUser()` call:
```typescript
// Before:
const userData = await currentUser();

// After:
const session = await auth.api.getSession({ headers: await headers() });
const userData = session?.user ?? null;
```

Replace the `NavUser` user prop:
```typescript
// Before:
user={{
  name: userData?.username ?? "shadcn",
  email: userData?.emailAddresses[0].emailAddress ?? "m@example.com",
  avatar: userData?.imageUrl ?? "/avatars/shadcn.jpg",
}}

// After:
user={{
  name: userData?.name ?? "",
  email: userData?.email ?? "",
  avatar: "",
}}
```

- [ ] **Step 5: Update `src/components/nav-user.tsx` — wire Log out button**

This file is a `"use client"` component. Add:
```typescript
import { signOut } from "@/lib/auth-client";
import { useRouter } from "next/navigation";
```

Inside `NavUser`, add:
```typescript
const router = useRouter();
```

Find the "Log out" `DropdownMenuItem` (around line 97) and add `onClick`:
```typescript
<DropdownMenuItem
  onClick={async () => {
    await signOut();
    router.push("/login");
  }}
>
  <IconLogout />
  Log out
</DropdownMenuItem>
```

- [ ] **Step 6: Update `src/components/inbox/inbox-client.tsx` — remove Clerk**

First, find all Clerk references in this 2008-line file:
```bash
grep -n "@clerk\|useAuth\|useUser\|getToken\|Authorization.*Bearer" \
  web/xedmail/src/components/inbox/inbox-client.tsx
```

For each location:
1. Remove any `import { useAuth, useUser } from "@clerk/nextjs"` import line
2. Remove any `const { getToken } = useAuth()` declarations inside components
3. Remove any `const { user } = useUser()` declarations inside components
4. For each `getToken()` call pattern: remove the `const token = await getToken()` line and the `Authorization: \`Bearer ${token}\`` header from the fetch options object. Keep everything else in the fetch call intact.

- [ ] **Step 7: Verify `src/app/home/page.tsx` builds cleanly**

```bash
cd web/xedmail && bun run build 2>&1 | grep -i "home\|app-sidebar" | head -10
```

Expected: no errors referencing these files.

- [ ] **Step 8: Full build check**

```bash
cd web/xedmail && bun run build 2>&1 | tail -20
```

Expected: build succeeds.

- [ ] **Step 9: Commit**

```bash
git add web/xedmail/src/app/layout.tsx \
        web/xedmail/src/app/page.tsx \
        web/xedmail/src/app/inbox/page.tsx \
        web/xedmail/src/components/app-sidebar.tsx \
        web/xedmail/src/components/nav-user.tsx \
        web/xedmail/src/components/inbox/inbox-client.tsx
git commit -m "feat: replace Clerk hooks in app components"
```

---

## Task 6: Wire Jazz provider to BetterAuth

**Commit:** `feat: wire Jazz provider to BetterAuth`

**Files:**
- Modify: `web/xedmail/src/providers/jazz-provider.tsx`

---

The current `jazz-provider.tsx` uses `JazzClerkAuth`, `RegisterClerkAuth`, and `initializeClerkAuth`. These are entirely Clerk-specific and are replaced by `AuthProvider` from `jazz-tools/better-auth/auth/react`, which wires Jazz to the BetterAuth session automatically.

The `JazzInboxStateProvider`, `JazzInboxContext`, `useJazzInboxState`, and all the inbox state logic **stay unchanged** — only the auth adapter changes.

- [ ] **Step 1: Update imports**

Remove these Clerk/auth-specific imports:
```typescript
// Remove entirely:
import { useClerk, useUser } from "@clerk/nextjs";
import {
  AuthSecretStorage,
  co,
  InMemoryKVStore,
  isClerkCredentials,
  JazzClerkAuth,
  KvStoreContext,
} from "jazz-tools";
```

Also update the `jazz-tools/react` import — remove `useAuthSecretStorage` and `useJazzContextValue` (both are only used inside `RegisterClerkAuth`, which is deleted in Step 2):
```typescript
// Before (line ~17):
import {
  JazzReactProvider,
  useAccount,
  useAuthSecretStorage,
  useJazzContextValue,
} from "jazz-tools/react";

// After (keep only what JazzInboxStateProvider uses):
import {
  JazzReactProvider,
  useAccount,
} from "jazz-tools/react";
```

Add:
```typescript
import { AuthProvider } from "jazz-tools/better-auth/auth/react";
import { authClient } from "@/lib/auth-client";
import { co, InMemoryKVStore, KvStoreContext } from "jazz-tools";
```

- [ ] **Step 2: Delete the two Clerk-specific functions**

Delete `initializeClerkAuth` (lines 94–109) and `RegisterClerkAuth` component (lines 111–174) in their entirety. The `setupKvStore`, `getSyncConfig`, and `hasJazzSyncPeer` helper functions stay.

- [ ] **Step 3: Replace the `JazzProvider` function**

Replace lines 526–560 with:

```typescript
export function JazzProvider({ children }: { children: React.ReactNode }) {
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    setupKvStore();
    setIsReady(true);
  }, []);

  if (!isReady) return null;

  return (
    <JazzReactProvider
      AccountSchema={JazzMailAccount}
      sync={getSyncConfig()}
      fallback={null}
      onLogOut={() => authClient.signOut()}
      authSecretStorageKey={JAZZ_AUTH_SECRET_STORAGE_KEY}
    >
      <AuthProvider betterAuthClient={authClient}>
        <JazzInboxStateProvider>{children}</JazzInboxStateProvider>
      </AuthProvider>
    </JazzReactProvider>
  );
}
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd web/xedmail && bun run build 2>&1 | grep "error TS" | head -20
```

Expected: no errors. If `AuthProvider` props differ, check the type definition:
```bash
cat web/xedmail/node_modules/jazz-tools/dist/better-auth/auth/react.d.ts
```

- [ ] **Step 5: Commit**

```bash
git add web/xedmail/src/providers/jazz-provider.tsx
git commit -m "feat: wire Jazz provider to BetterAuth"
```

---

## Task 7: Remove Clerk dependency

**Commit:** `chore: remove Clerk dependency`

**Files:**
- Modify: `web/xedmail/package.json`

---

- [ ] **Step 1: Confirm no remaining Clerk imports**

```bash
grep -r "@clerk" web/xedmail/src --include="*.ts" --include="*.tsx" -l
```

Expected: **no output**. If any files appear, open them and remove the Clerk references before continuing.

- [ ] **Step 2: Remove `@clerk/nextjs`**

```bash
cd web/xedmail && bun remove @clerk/nextjs
```

Expected: `@clerk/nextjs` removed from `package.json` and `bun.lock` updated.

- [ ] **Step 3: Remove Clerk env vars from `.env.local`**

Open `web/xedmail/.env.local` and delete the two lines:
```
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=...
CLERK_SECRET_KEY=...
```

- [ ] **Step 4: Final build**

```bash
cd web/xedmail && bun run build 2>&1 | tail -30
```

Expected: build succeeds with no errors.

- [ ] **Step 5: Smoke test**

```bash
cd web/xedmail && bun run dev
```

Open http://localhost:3000. Expected behaviour:
- Immediately redirected to `/login`
- Login page renders: Google button, email+pw form, magic link toggle, matching dark theme
- No `@clerk` or Clerk-related console errors
- Sign in with Google redirects to `/` after auth

- [ ] **Step 6: Commit**

```bash
git add web/xedmail/package.json web/xedmail/bun.lock
git commit -m "chore: remove Clerk dependency"
```
