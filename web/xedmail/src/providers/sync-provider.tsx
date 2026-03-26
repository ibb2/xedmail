"use client";

import React, { createContext, useContext, useEffect, useRef } from "react";
import { useSession } from "@/lib/auth-client";
import { db, getSyncState, setSyncState } from "@/lib/dexie";
import { addToIndex, rehydrateIndex, removeFromIndex } from "@/lib/search-index";
import type { EmailMetadata } from "@/lib/dexie";

const ELYSIA_URL = process.env.NEXT_PUBLIC_ELYSIA_SERVICE_URL ?? "http://localhost:3001";

type SyncContextValue = { isReady: boolean };
const SyncContext = createContext<SyncContextValue>({ isReady: false });

async function writeBatch(emails: EmailMetadata[]) {
  await db.emails.bulkPut(emails);
  await addToIndex(emails);
}

async function openSSE(mailboxAddress: string, token: string) {
  const cursor = await getSyncState<number | null>(`backfillCursor_${mailboxAddress}`, null);
  const url = new URL(`${ELYSIA_URL}/stream`);
  url.searchParams.set("mailbox", mailboxAddress);
  url.searchParams.set("token", token);
  if (cursor) url.searchParams.set("cursor", String(cursor));

  const es = new EventSource(url.toString());

  es.onmessage = async (e) => {
    const msg = JSON.parse(e.data);

    if (msg.type === "batch") {
      const idleCallback: (fn: () => void) => void =
        typeof requestIdleCallback !== "undefined"
          ? (fn) => requestIdleCallback(fn)
          : (fn) => setTimeout(fn, 0);

      idleCallback(async () => {
        await writeBatch(msg.emails);
        if (msg.cursor) {
          await setSyncState(`backfillCursor_${mailboxAddress}`, msg.cursor);
        }
        // Update watermark from first batch
        const maxUid = Math.max(0, ...msg.emails.map((e: EmailMetadata) => e.uid));
        const current = await getSyncState<number>(`watermarkUid_${mailboxAddress}`, 0);
        if (maxUid > current) await setSyncState(`watermarkUid_${mailboxAddress}`, maxUid);
      });
    }

    if (msg.type === "backfill_complete") {
      await setSyncState(`backfillComplete_${mailboxAddress}`, true);
      await setSyncState(`watermarkUid_${mailboxAddress}`, msg.watermarkUid);
      es.close();
    }
  };

  es.onerror = () => es.close();
  return es;
}

function openWS(mailboxAddress: string, token: string) {
  const url = new URL(`${ELYSIA_URL.replace(/^http/, "ws")}/events`);
  url.searchParams.set("mailbox", mailboxAddress);
  url.searchParams.set("token", token);

  const ws = new WebSocket(url.toString());

  ws.onmessage = async (e) => {
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
  };

  return ws;
}

export function SyncProvider({ children }: { children: React.ReactNode }) {
  const { data: session } = useSession();
  const token = (session as any)?.session?.token as string | undefined;
  const esRefs = useRef<EventSource[]>([]);
  const wsRefs = useRef<WebSocket[]>([]);
  const [isReady, setIsReady] = React.useState(false);

  // Rehydrate FlexSearch from Dexie on mount
  useEffect(() => {
    rehydrateIndex().then(() => setIsReady(true));
  }, []);

  // Open SSE + WS for each mailbox when session is available
  useEffect(() => {
    if (!token) return;

    async function connect() {
      const mboxes = await fetch("/api/mail/mailboxes").then(r => r.json());
      const addresses: string[] = mboxes.map((m: { emailAddress: string }) => m.emailAddress);

      for (const addr of addresses) {
        // Re-open SSE if not complete
        const complete = await getSyncState<boolean>(`backfillComplete_${addr}`, false);
        if (!complete) {
          const es = await openSSE(addr, token!);
          esRefs.current.push(es);
        }
        const ws = openWS(addr, token!);
        wsRefs.current.push(ws);
      }
    }

    connect();

    return () => {
      esRefs.current.forEach(es => es.close());
      wsRefs.current.forEach(ws => ws.close());
      esRefs.current = [];
      wsRefs.current = [];
    };
  }, [token]);

  return (
    <SyncContext.Provider value={{ isReady }}>
      {children}
    </SyncContext.Provider>
  );
}

export function useSyncReady() {
  return useContext(SyncContext).isReady;
}
