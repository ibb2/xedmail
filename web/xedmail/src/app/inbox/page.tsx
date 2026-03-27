"use client";

import React, { Suspense, useEffect, useRef, useState } from "react";
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

function msResponseToIntent(query: string, data: ParseResponse): QueryIntent {
  const { filters } = data;

  if (filters.status === "unread") return { type: "status", seen: false };
  if (filters.status === "read") return { type: "status", seen: true };

  if (filters.from) return { type: "from", address: filters.from.toLowerCase() };

  if (filters.date) {
    const d = filters.date.toLowerCase();
    const now = new Date();
    const today = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    if (d.includes("today")) return { type: "date", date: today };
    if (d.includes("yesterday")) {
      const yesterday = new Date(today);
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      return { type: "date", date: yesterday };
    }
  }

  return { type: "keyword", text: query.trim().toLowerCase() };
}

function InboxPage() {
  const syncReady = useSyncReady();
  const { isSyncing } = useSyncState();
  const emails = useAllInboxEmails();
  const searchParams = useSearchParams();
  const query = searchParams.get("query")?.trim() ?? "";

  const [displayedEmails, setDisplayedEmails] = useState<EmailMetadata[]>([]);
  const [isServerSearching, setIsServerSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Runs on every query/emails change — parses intent (FastAPI → regex fallback),
  // filters Dexie cache, then falls back to IMAP server search if needed.
  useEffect(() => {
    if (!query) {
      setDisplayedEmails(emails);
      setIsServerSearching(false);
      return;
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(async () => {
      // 1. Parse intent via FastAPI; fall back to regex if unavailable
      let intent: QueryIntent;
      try {
        const res = await fetch(
          `/api/mail/parse?q=${encodeURIComponent(query)}`,
          { signal: AbortSignal.timeout(3000) },
        );
        const data: ParseResponse = res.ok
          ? await res.json()
          : { intent: null, filters: {} };
        intent =
          data.intent === "search_emails"
            ? msResponseToIntent(query, data)
            : parseQueryIntent(query); // regex fallback
      } catch {
        intent = parseQueryIntent(query); // offline fallback
      }

      // 2. Apply structured filters directly to Dexie cache
      if (intent.type !== "keyword" && intent.type !== "all") {
        const filtered = filterByIntent(emails, intent);
        setDisplayedEmails(filtered);
        setIsServerSearching(false);
        return;
      }

      // 3. Keyword — try FlexSearch over full indexed body text
      const matchedIds = new Set(searchIndex(query));
      if (matchedIds.size > 0) {
        setDisplayedEmails(emails.filter(e => matchedIds.has(e.id)));
        setIsServerSearching(false);
        return;
      }

      // 4. Substring fallback against cached metadata
      const substringMatches = filterByIntent(emails, intent);
      if (substringMatches.length > 0) {
        setDisplayedEmails(substringMatches);
        setIsServerSearching(false);
        return;
      }

      // 5. Nothing local — hit IMAP server search
      setIsServerSearching(true);
      try {
        const res = await fetch(
          `/api/mail/search?q=${encodeURIComponent(query)}`,
        );
        if (res.ok) {
          const data = await res.json();
          setDisplayedEmails(data.emails ?? []);
        }
      } catch {
        setDisplayedEmails([]);
      } finally {
        setIsServerSearching(false);
      }
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, emails]);

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
