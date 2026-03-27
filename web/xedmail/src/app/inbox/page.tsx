"use client";

import React, { Suspense, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import InboxClient from "@/components/inbox/inbox-client";
import { useAllInboxEmails } from "@/hooks/use-inbox";
import { searchIndex } from "@/lib/search-index";
import { parseQueryIntent, filterByIntent } from "@/lib/client-query";
import { useSyncReady } from "@/providers/sync-provider";

function InboxPage() {
  const syncReady = useSyncReady();
  const emails = useAllInboxEmails();
  const searchParams = useSearchParams();
  const query = searchParams.get("query")?.trim() ?? "";

  const filteredEmails = useMemo(() => {
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

  return (
    <InboxClient
      emails={filteredEmails}
      isLoading={!syncReady && emails.length === 0}
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
