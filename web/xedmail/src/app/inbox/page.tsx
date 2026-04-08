"use client";

import React, { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import InboxClient from "@/components/inbox/inbox-client";
import { useAllInboxEmails } from "@/hooks/use-inbox";
import { searchIndex } from "@/lib/search-index";
import { parseQueryIntent, filterByIntent } from "@/lib/client-query";
import { useSyncReady, useSyncState } from "@/providers/sync-provider";
import type { EmailMetadata } from "@/lib/dexie";
import type { QueryIntent } from "@/lib/client-query";

type ParseResponse = {
  intent: string | null;
  filters: {
    status?: string;
    from?: string;
    date?: string;
  };
};

function parseResponseToIntent(query: string, data: ParseResponse): QueryIntent | null {
  const f = data.filters ?? {};
  if (f.status === "unread") return { type: "status", seen: false };
  if (f.status === "read") return { type: "status", seen: true };
  if (f.from) return { type: "from", address: f.from.toLowerCase() };
  if (f.date) {
    const d = f.date.toLowerCase();
    const now = new Date();
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    if (d.includes("today")) return { type: "date", date: today };
    if (d.includes("yesterday")) {
      const yesterday = new Date(today);
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      return { type: "date", date: yesterday };
    }
  }
  return null; // no structure extracted
}

function InboxPage() {
  const syncReady = useSyncReady();
  const { isSyncing } = useSyncState();
  const emails = useAllInboxEmails();
  const searchParams = useSearchParams();
  const query = searchParams.get("query")?.trim() ?? "";

  // Regex parse — synchronous, instant. Handles well-defined structured
  // patterns (unread, from:x, today, yesterday). Returns "keyword" for
  // anything it can't classify structurally.
  const regexIntent = useMemo(() => parseQueryIntent(query), [query]);

  // Structured queries resolved entirely from Dexie — no network call.
  // Keyword queries fall through to the async path below.
  const localResults = useMemo(() => {
    if (!query) return emails;

    if (regexIntent.type !== "keyword" && regexIntent.type !== "all") {
      return filterByIntent(emails, regexIntent);
    }

    // Keyword: FlexSearch over full indexed body text first
    const matchedIds = new Set(searchIndex(query));
    if (matchedIds.size > 0) return emails.filter(e => matchedIds.has(e.id));

    // Substring scan of cached metadata (subject / from name / address)
    return filterByIntent(emails, regexIntent);
  }, [emails, query, regexIntent]);

  // FastAPI NLP — only called for keyword queries. Tries to extract structure
  // that regex can't detect ("emails from my boss last week", "unread about
  // the budget"). If FastAPI finds structure, re-filters Dexie with it.
  // Falls back to IMAP if no local hits remain.
  const [serverResults, setServerResults] = useState<EmailMetadata[] | null>(null);
  const [isServerSearching, setIsServerSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setServerResults(null);
    setIsServerSearching(false);
    if (debounceRef.current) clearTimeout(debounceRef.current);

    // Only keyword queries go to FastAPI / IMAP
    if (!query || regexIntent.type !== "keyword") return;

    debounceRef.current = setTimeout(async () => {
      // Ask FastAPI if it can extract structure regex missed
      try {
        const res = await fetch(`/api/mail/parse?q=${encodeURIComponent(query)}`);
        if (res.ok) {
          const data: ParseResponse = await res.json();
          if (data.intent === "search_emails") {
            const nlpIntent = parseResponseToIntent(query, data);
            if (nlpIntent) {
              const filtered = filterByIntent(emails, nlpIntent);
              if (filtered.length > 0) {
                setServerResults(filtered);
                return;
              }
            }
          }
        }
      } catch {
        // FastAPI unavailable — fall through
      }

      // Local results exist from FlexSearch / substring — don't hit IMAP
      if (localResults.length > 0) return;

      // Nothing local — IMAP full-text search as last resort
      setIsServerSearching(true);
      try {
        const res = await fetch(`/api/mail/search?q=${encodeURIComponent(query)}`);
        if (res.ok) {
          const data = await res.json();
          setServerResults(data.emails ?? []);
        }
      } catch {
        setServerResults([]);
      } finally {
        setIsServerSearching(false);
      }
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, regexIntent.type, localResults.length, emails]);

  const displayedEmails = serverResults ?? localResults;

  return (
    <InboxClient
      emails={displayedEmails}
      isLoading={!syncReady && emails.length === 0}
      isServerSearching={isServerSearching}
      isSyncing={isSyncing}
      syncedCount={emails.length}
      query={query}
    />
  );
}

export default function Inbox() {
  return (
    <Suspense>
      <InboxPage />
    </Suspense>
  );
}
