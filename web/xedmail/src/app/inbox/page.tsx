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

function msFiltersToIntent(query: string, filters: ParseResponse["filters"]): QueryIntent | null {
  if (filters.status === "unread") return { type: "status", seen: false };
  if (filters.status === "read") return { type: "status", seen: true };
  if (filters.from) return { type: "from", address: filters.from.toLowerCase() };
  if (filters.date) {
    const d = filters.date.toLowerCase();
    const now = new Date();
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    if (d.includes("today")) return { type: "date", date: today };
    if (d.includes("yesterday")) {
      const yesterday = new Date(today);
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      return { type: "date", date: yesterday };
    }
  }
  return null; // no structured filters extracted
}

function InboxPage() {
  const syncReady = useSyncReady();
  const { isSyncing } = useSyncState();
  const emails = useAllInboxEmails();
  const searchParams = useSearchParams();
  const query = searchParams.get("query")?.trim() ?? "";

  const [serverResults, setServerResults] = useState<EmailMetadata[] | null>(null);
  const [isServerSearching, setIsServerSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Regex parse — synchronous, runs on every render, instant structured filtering.
  const regexIntent = useMemo(() => parseQueryIntent(query), [query]);

  // Structured queries (unread/read/today/from:x) — filter Dexie immediately,
  // no API call needed. Only keyword queries fall through to the async path.
  const localResults = useMemo(() => {
    if (!query) return emails;
    if (regexIntent.type !== "keyword" && regexIntent.type !== "all") {
      return filterByIntent(emails, regexIntent);
    }
    // Keyword: FlexSearch over full indexed body text
    const matchedIds = new Set(searchIndex(query));
    if (matchedIds.size > 0) return emails.filter(e => matchedIds.has(e.id));
    // Substring fallback on cached metadata
    return filterByIntent(emails, regexIntent);
  }, [emails, query, regexIntent]);

  // FastAPI NLP — only called for keyword queries where regex found nothing
  // structured. Tries to extract hidden structure ("emails from my boss last
  // week") that a regex can't detect. Falls back gracefully if unavailable.
  useEffect(() => {
    // Clear server results whenever query changes or local results arrive
    if (!query || regexIntent.type !== "keyword") {
      setServerResults(null);
      setIsServerSearching(false);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      return;
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(async () => {
      // Try FastAPI to see if it can extract structure from the NL query
      try {
        const res = await fetch(
          `/api/mail/parse?q=${encodeURIComponent(query)}`,
          { signal: AbortSignal.timeout(2000) },
        );
        if (res.ok) {
          const data: ParseResponse = await res.json();
          if (data.intent === "search_emails" && data.filters) {
            const nlpIntent = msFiltersToIntent(query, data.filters);
            if (nlpIntent) {
              // FastAPI found structure — filter Dexie with it
              const filtered = filterByIntent(emails, nlpIntent);
              if (filtered.length > 0) {
                setServerResults(filtered);
                return;
              }
            }
          }
        }
      } catch {
        // FastAPI unavailable — fall through to IMAP
      }

      // No local hits from NLP or regex — fall back to IMAP full-text search
      if (localResults.length > 0) {
        // Local results exist, no need for IMAP
        setServerResults(null);
        return;
      }

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
