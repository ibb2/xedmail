"use client";

import React, { useMemo } from "react";
import { useSearchParams } from "next/navigation";
import InboxClient from "@/components/inbox/inbox-client";
import { useAllInboxEmails } from "@/hooks/use-inbox";
import { searchIndex } from "@/lib/search-index";
import { useSyncReady } from "@/providers/sync-provider";

export default function Inbox() {
  const syncReady = useSyncReady();
  const emails = useAllInboxEmails();
  const searchParams = useSearchParams();
  const query = searchParams.get("query")?.trim() ?? "";

  const filteredEmails = useMemo(() => {
    if (!query) return emails;
    const matchedIds = new Set(searchIndex(query));
    if (matchedIds.size > 0) return emails.filter(e => matchedIds.has(e.id));

    // Fallback: server search handled in InboxClient via /api/mail/search
    return emails;
  }, [emails, query]);

  return (
    <InboxClient
      emails={filteredEmails}
      isLoading={!syncReady && emails.length === 0}
      query={query}
    />
  );
}
