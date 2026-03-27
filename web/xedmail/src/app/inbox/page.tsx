"use client";

import React, { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import InboxClient from "@/components/inbox/inbox-client";
import { useAllInboxEmails } from "@/hooks/use-inbox";
import { searchIndex } from "@/lib/search-index";
import { parseQueryIntent, filterByIntent } from "@/lib/client-query";
import { useSyncReady, useSyncState } from "@/providers/sync-provider";
import type { EmailMetadata } from "@/lib/dexie";

function InboxPage() {
  const syncReady = useSyncReady();
  const { isSyncing } = useSyncState();
  const emails = useAllInboxEmails();
  const searchParams = useSearchParams();
  const query = searchParams.get("query")?.trim() ?? "";

  const [serverResults, setServerResults] = useState<EmailMetadata[] | null>(null);
  const [isServerSearching, setIsServerSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const localResults = useMemo(() => {
    if (!query) return emails;

    const intent = parseQueryIntent(query);

    // Structured filters (unread, read, today, yesterday, from:x) — apply directly
    if (intent.type !== "keyword" && intent.type !== "all") {
      return filterByIntent(emails, intent);
    }

    // Keyword: try FlexSearch first, fall back to substring filter
    const matchedIds = new Set(searchIndex(query));
    if (matchedIds.size > 0) return emails.filter(e => matchedIds.has(e.id));

    return filterByIntent(emails, intent);
  }, [emails, query]);

  // Trigger server search when local keyword results are empty
  useEffect(() => {
    if (!query) {
      setServerResults(null);
      return;
    }
    const intent = parseQueryIntent(query);
    // Only fall back to server for keyword queries with no local hits
    if (intent.type !== "keyword" || localResults.length > 0) {
      setServerResults(null);
      return;
    }

    setIsServerSearching(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/mail/search?q=${encodeURIComponent(query)}`);
        if (res.ok) {
          const data = await res.json();
          setServerResults(data.emails ?? []);
        }
      } catch {
        // silently fall back to empty
      } finally {
        setIsServerSearching(false);
      }
    }, 400);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, localResults.length]);

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
