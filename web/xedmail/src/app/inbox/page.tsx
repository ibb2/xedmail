"use client";
import InboxClient from "@/components/inbox/inbox-client";
import { useAuth } from "@clerk/nextjs";
import { useSearchParams } from "next/navigation";
import React from "react";
import { useJazzInboxState } from "@/providers/jazz-provider";

const POLL_INTERVAL_MS = 30000;

export default function Inbox() {
  const { getToken } = useAuth();
  const { messages, folders, mailboxes, syncInbox } = useJazzInboxState();
  const searchParams = useSearchParams();
  const query = searchParams.get("query")?.trim() ?? "";
  const isFetchingRef = React.useRef(false);

  const getAllEmails = React.useCallback(async (includeFolders: boolean) => {
    if (isFetchingRef.current) {
      return;
    }

    isFetchingRef.current = true;

    const token = await getToken();

    try {
      const response = await fetch(
        `/api/mail/search?query=${encodeURIComponent(query)}&includeFolders=${includeFolders}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      );

      if (!response.ok) {
        return;
      }

      const payload = await response.json();
      syncInbox({
        messages: payload.emails ?? [],
        folders: payload.folders ?? (includeFolders ? [] : folders),
        mailboxes,
      });
    } finally {
      isFetchingRef.current = false;
    }
  }, [folders, getToken, mailboxes, query, syncInbox]);

  React.useEffect(() => {
    void getAllEmails(false);

    const interval = window.setInterval(() => {
      void getAllEmails(false);
    }, POLL_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, [getAllEmails]);

  return <InboxClient emails={messages} />;
}
