"use client";

import React, { createContext, useContext, useEffect, useRef } from "react";
import { useSession } from "@/lib/auth-client";
import { db, getSyncState, setSyncState } from "@/lib/dexie";
import {
  addToIndex,
  rehydrateIndex,
  removeFromIndex,
} from "@/lib/search-index";
import type { EmailMetadata } from "@/lib/dexie";

const ELYSIA_URL =
  process.env.NEXT_PUBLIC_ELYSIA_SERVICE_URL ?? "http://localhost:3001";

// Issue 5: idleCallback polyfill at module scope (not redeclared per message)
const idleCallback: (fn: () => void) => void =
  typeof requestIdleCallback !== "undefined"
    ? (fn) => requestIdleCallback(fn)
    : (fn) => setTimeout(fn, 0);

type SyncContextValue = { isReady: boolean };
const SyncContext = createContext<SyncContextValue>({ isReady: false });

async function writeBatch(emails: EmailMetadata[]) {
  await db.emails.bulkPut(emails);
  await addToIndex(emails);
}

async function openSSE(mailboxAddress: string, token: string) {
  const cursor = await getSyncState<number | null>(
    `backfillCursor_${mailboxAddress}`,
    null,
  );
  const url = new URL(`${ELYSIA_URL}/stream`);
  url.searchParams.set("mailbox", mailboxAddress);
  url.searchParams.set("token", token);
  if (cursor) url.searchParams.set("cursor", String(cursor));

  const es = new EventSource(url.toString());

  es.onmessage = (e) => {
    (async () => {
      const msg = JSON.parse(e.data);

      if (msg.type === "batch") {
        idleCallback(() => {
          (async () => {
            await writeBatch(msg.emails);
            if (msg.cursor) {
              await setSyncState(
                `backfillCursor_${mailboxAddress}`,
                msg.cursor,
              );
            }
            // Update high-water mark UID
            const maxUid = Math.max(
              0,
              ...msg.emails.map((e: EmailMetadata) => e.uid),
            );
            const current = await getSyncState<number>(
              `watermarkUid_${mailboxAddress}`,
              0,
            );
            if (maxUid > current)
              await setSyncState(`watermarkUid_${mailboxAddress}`, maxUid);
          })().catch(console.error);
        });
      }

      if (msg.type === "backfill_complete") {
        await setSyncState(`backfillComplete_${mailboxAddress}`, true);
        await setSyncState(`watermarkUid_${mailboxAddress}`, msg.watermarkUid);
        es.close();
      }
    })().catch(console.error);
  };

  // Issue 3: Let EventSource auto-reconnect on transient errors; only no-op if already closed
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) return; // already closed, nothing to do
    // For truly unrecoverable errors, EventSource will close itself
  };

  return es;
}

function openWS(mailboxAddress: string, token: string) {
  const url = new URL(`${ELYSIA_URL.replace(/^http/, "ws")}/events`);
  url.searchParams.set("mailbox", mailboxAddress);
  url.searchParams.set("token", token);

  const ws = new WebSocket(url.toString());

  ws.onmessage = (e) => {
    (async () => {
      const msg = JSON.parse(e.data);

      if (msg.type === "exists") {
        await writeBatch(msg.emails);
      }
      if (msg.type === "expunge") {
        await db.emails.delete(msg.id);
        await db.bodies.delete(msg.id);
        removeFromIndex(msg.id);
      }
      if (msg.type === "flags") {
        await db.emails.where("id").equals(msg.id).modify({
          isRead: msg.isRead,
          isStarred: msg.isStarred,
        });
      }
      if (msg.type === "auth_error") {
        ws.close();
      }
    })().catch(console.error);
  };

  return ws;
}

export function SyncProvider({ children }: { children: React.ReactNode }) {
  const { data: session } = useSession();
  const token = (session as any)?.session?.token as string | undefined;
  const esRefs = useRef<EventSource[]>([]);
  const wsRefs = useRef<WebSocket[]>([]);
  const [isReady, setIsReady] = React.useState(false);

  // Evict stale bodies then rehydrate FlexSearch from Dexie on mount
  useEffect(() => {
    async function init() {
      // Evict stale bodies (>30 days)
      const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const stale = await db.bodies.where("lastAccessed").below(thirtyDaysAgo).toArray();
      if (stale.length) {
        const freedBytes = stale.reduce((sum, b) => sum + b.byteSize, 0);
        await db.bodies.bulkDelete(stale.map(b => b.id));
        const prev = await getSyncState<number>("totalBodyBytes", 0);
        await setSyncState("totalBodyBytes", Math.max(0, prev - freedBytes));
      }

      await rehydrateIndex();
      setIsReady(true);
    }
    init().catch(console.error);
  }, []);

  // Open SSE + WS for each mailbox when session is available
  useEffect(() => {
    if (!token) return;
    const activeToken: string = token;
    // Issue 1: cancellation flag to guard against cleanup running before connect() resolves
    let cancelled = false;

    async function connect() {
      // Issue 2: error handling for mailboxes fetch
      const r = await fetch("/api/mail/mailboxes");
      if (!r.ok) {
        console.error("[SyncProvider] failed to fetch mailboxes:", r.status);
        return;
      }
      const mboxes = await r.json();
      const addresses: string[] = mboxes.map(
        (m: { emailAddress: string }) => m.emailAddress,
      );

      for (const addr of addresses) {
        if (cancelled) break;
        // Re-open SSE if not complete
        const complete = await getSyncState<boolean>(
          `backfillComplete_${addr}`,
          false,
        );
        if (!complete) {
          const es = await openSSE(addr, activeToken);
          if (cancelled) { es.close(); break; }
          esRefs.current.push(es);
        }
        if (cancelled) break;
        const ws = openWS(addr, activeToken);
        wsRefs.current.push(ws);
      }
    }

    connect().catch(console.error);

    return () => {
      cancelled = true;
      esRefs.current.forEach((es) => es.close());
      wsRefs.current.forEach((ws) => ws.close());
      esRefs.current = [];
      wsRefs.current = [];
    };
  }, [token]);

  return (
    <SyncContext.Provider value={{ isReady }}>{children}</SyncContext.Provider>
  );
}

export function useSyncReady() {
  return useContext(SyncContext).isReady;
}
