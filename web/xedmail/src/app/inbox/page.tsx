"use client";
import InboxClient from "@/components/inbox/inbox-client";
import { useAuth } from "@clerk/nextjs";
import { useSearchParams } from "next/navigation";
import React from "react";
import { useJazzInboxState } from "@/providers/jazz-provider";

const POLL_INTERVAL_MS = 30000;

export default function Inbox() {
  const { getToken } = useAuth();
  const {
    messages, folders, mailboxes, syncInbox,
    syncScheduledEmails, snoozeMessage,
  } = useJazzInboxState();
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

  const messagesRef = React.useRef(messages);
  React.useEffect(() => { messagesRef.current = messages; }, [messages]);

  const resurfaceSnoozedMessages = React.useCallback(() => {
    const now = new Date();
    for (const msg of messagesRef.current) {
      if (msg.snoozedUntil && new Date(msg.snoozedUntil) <= now) {
        snoozeMessage({ uid: msg.uid, mailboxAddress: msg.mailboxAddress }, undefined);
      }
    }
  }, [snoozeMessage]);

  const localSearchResults = React.useMemo(() => {
    if (!query) return messages;
    const q = query.toLowerCase();
    return messages.filter(
      (m) =>
        m.subject.toLowerCase().includes(q) ||
        (m.from[0] ?? "").toLowerCase().includes(q) ||
        (m.from[1] ?? "").toLowerCase().includes(q),
    );
  }, [messages, query]);

  const localSearchResultsRef = React.useRef(localSearchResults);
  React.useEffect(() => { localSearchResultsRef.current = localSearchResults; }, [localSearchResults]);

  const getAllEmails = React.useCallback(async (includeFolders: boolean) => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    const requestId = ++requestIdRef.current;
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    const isInitialLoad = messagesRef.current.length === 0;
    if (isInitialLoad) setIsLoading(true);

    try {
      const token = await getToken();

      if (isInitialLoad) {
        // Initial full fetch
        const response = await fetch(
          `/api/mail/search?query=&includeFolders=${includeFolders}`,
          { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: abortController.signal },
        );
        if (!response.ok || requestIdRef.current !== requestId) return;
        const payload = await response.json();
        syncInbox({
          messages: payload.emails ?? [],
          folders: payload.folders ?? (includeFolders ? [] : foldersRef.current),
          mailboxes: mailboxesRef.current,
        });
        if (includeFolders) hasFetchedFoldersRef.current = true;
      } else {
        // Incremental: only fetch UIDs above watermark per mailbox
        const uniqueMailboxes = [...new Set(messagesRef.current.map((m) => m.mailboxAddress))];
        for (const mailboxAddress of uniqueMailboxes) {
          if (requestIdRef.current !== requestId) break;
          const maxUid = Math.max(
            0,
            ...messagesRef.current
              .filter((m) => m.mailboxAddress === mailboxAddress)
              .map((m) => parseInt(m.uid, 10))
              .filter((n) => !Number.isNaN(n)),
          );
          const response = await fetch(
            `/api/mail/new?minUid=${maxUid}&mailbox=${encodeURIComponent(mailboxAddress)}`,
            { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: abortController.signal },
          );
          if (!response.ok || requestIdRef.current !== requestId) continue;
          const payload = await response.json();
          if ((payload.emails ?? []).length > 0) {
            syncInbox({ messages: payload.emails, folders: [], mailboxes: mailboxesRef.current });
          }
        }
      }

      // Hybrid search: fall back to server if local results are sparse
      if (query && localSearchResultsRef.current.length < 5 && requestIdRef.current === requestId) {
        const response = await fetch(
          `/api/mail/search?query=${encodeURIComponent(query)}&includeFolders=false`,
          { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: abortController.signal },
        );
        if (response.ok && requestIdRef.current === requestId) {
          const payload = await response.json();
          if ((payload.emails ?? []).length > 0) {
            syncInbox({ messages: payload.emails, folders: [], mailboxes: mailboxesRef.current });
          }
        }
      }

      // Resurface snoozed emails
      resurfaceSnoozedMessages();

      // Sync scheduled emails
      if (requestIdRef.current === requestId) {
        const scheduledResponse = await fetch("/api/mail/scheduled", {
          headers: { Authorization: `Bearer ${token}` },
          signal: abortController.signal,
        });
        if (scheduledResponse.ok && requestIdRef.current === requestId) {
          const { scheduled } = await scheduledResponse.json();
          syncScheduledEmails(scheduled ?? []);
        }
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
    } finally {
      if (requestIdRef.current === requestId) {
        isFetchingRef.current = false;
        setIsLoading(false);
      }
    }
  }, [getToken, query, syncInbox, syncScheduledEmails, resurfaceSnoozedMessages]);

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

  return <InboxClient emails={localSearchResults} isLoading={isLoading} query={query} />;
}
