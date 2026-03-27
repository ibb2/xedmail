"use client";

import React, { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import InboxClient from "@/components/inbox/inbox-client";
import { useAllInboxEmails } from "@/hooks/use-inbox";
import { searchIndex } from "@/lib/search-index";
import { filterByIntent } from "@/lib/client-query";
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

function parseResponseToIntent(query: string, data: ParseResponse): QueryIntent {
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

  useEffect(() => {
    if (!query) {
      setDisplayedEmails(emails);
      setIsServerSearching(false);
      return;
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(async () => {
      // 1. Ask FastAPI to parse the query into structured filters.
      //    If unavailable (500ms timeout), treat as a plain keyword.
      let intent: QueryIntent = { type: "keyword", text: query.toLowerCase() };
      try {
        const res = await fetch(`/api/mail/parse?q=${encodeURIComponent(query)}`);
        if (res.ok) {
          const data: ParseResponse = await res.json();
          if (data.intent === "search_emails") {
            intent = parseResponseToIntent(query, data);
          }
        }
      } catch {
        // FastAPI unavailable — intent stays as keyword
      }

      // 2. Structured filter (from/status/date) — apply directly to Dexie cache
      if (intent.type !== "keyword" && intent.type !== "all") {
        setDisplayedEmails(filterByIntent(emails, intent));
        setIsServerSearching(false);
        return;
      }

      // 3. Keyword — FlexSearch over full indexed body text
      const matchedIds = new Set(searchIndex(query));
      if (matchedIds.size > 0) {
        setDisplayedEmails(emails.filter(e => matchedIds.has(e.id)));
        setIsServerSearching(false);
        return;
      }

      // 4. Substring scan of cached metadata (subject / from)
      const substring = filterByIntent(emails, intent);
      if (substring.length > 0) {
        setDisplayedEmails(substring);
        setIsServerSearching(false);
        return;
      }

      // 5. Nothing local — fall back to IMAP full-text search
      setIsServerSearching(true);
      try {
        const res = await fetch(`/api/mail/search?q=${encodeURIComponent(query)}`);
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
