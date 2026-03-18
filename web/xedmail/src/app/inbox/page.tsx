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
  const requestIdRef = React.useRef(0);
  const abortControllerRef = React.useRef<AbortController | null>(null);
  const hasFetchedFoldersRef = React.useRef(false);
  const foldersRef = React.useRef(folders);
  const mailboxesRef = React.useRef(mailboxes);
  const [isLoading, setIsLoading] = React.useState(true);

  React.useEffect(() => {
    foldersRef.current = folders;
  }, [folders]);

  React.useEffect(() => {
    mailboxesRef.current = mailboxes;
  }, [mailboxes]);

  const getAllEmails = React.useCallback(async (includeFolders: boolean) => {
    if (isFetchingRef.current) {
      return;
    }

    isFetchingRef.current = true;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    setIsLoading(true);

    try {
      const token = await getToken();
      const response = await fetch(
        `/api/mail/search?query=${encodeURIComponent(query)}&includeFolders=${includeFolders}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
          cache: "no-store",
          signal: abortController.signal,
        },
      );

      if (!response.ok || requestIdRef.current !== requestId) {
        return;
      }

      const payload = await response.json();
      syncInbox({
        messages: payload.emails ?? [],
        folders: payload.folders ?? (includeFolders ? [] : foldersRef.current),
        mailboxes: mailboxesRef.current,
      });
      if (includeFolders) {
        hasFetchedFoldersRef.current = true;
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return;
      }
    } finally {
      if (requestIdRef.current === requestId) {
        isFetchingRef.current = false;
        setIsLoading(false);
      }
    }
  }, [getToken, query, syncInbox]);

  React.useEffect(() => {
    abortControllerRef.current?.abort();
    isFetchingRef.current = false;
    void getAllEmails(!hasFetchedFoldersRef.current);

    const interval = window.setInterval(() => {
      void getAllEmails(false);
    }, POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(interval);
      abortControllerRef.current?.abort();
      isFetchingRef.current = false;
    };
  }, [getAllEmails, query]);

  return <InboxClient emails={messages} isLoading={isLoading} query={query} />;
}
