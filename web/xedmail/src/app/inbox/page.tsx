"use client";
import { useSession } from "@/lib/auth-client";
import { useSearchParams } from "next/navigation";
import React from "react";
import InboxClient from "@/components/inbox/inbox-client";
import { filterByIntent, parseQueryIntent } from "@/lib/client-query";
import { useJazzInboxState } from "@/providers/jazz-provider";

const POLL_INTERVAL_MS = 30000;
const SPARSE_THRESHOLD = 5;

export default function Inbox() {
  const { data: _session } = useSession();
  const {
    isLoaded: isJazzLoaded,
    messages,
    folders,
    mailboxes,
    syncInbox,
    syncScheduledEmails,
    snoozeMessage,
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
  const [serverMatchedKeys, setServerMatchedKeys] = React.useState<
    Set<string>
  >(new Set());

  React.useEffect(() => {
    foldersRef.current = folders;
  }, [folders]);

  React.useEffect(() => {
    mailboxesRef.current = mailboxes;
  }, [mailboxes]);

  const messagesRef = React.useRef(messages);
  React.useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const syncInboxRef = React.useRef(syncInbox);
  React.useEffect(() => {
    syncInboxRef.current = syncInbox;
  }, [syncInbox]);

  const syncScheduledEmailsRef = React.useRef(syncScheduledEmails);
  React.useEffect(() => {
    syncScheduledEmailsRef.current = syncScheduledEmails;
  }, [syncScheduledEmails]);

  const snoozeMessageRef = React.useRef(snoozeMessage);
  React.useEffect(() => {
    snoozeMessageRef.current = snoozeMessage;
  }, [snoozeMessage]);

  const resurfaceSnoozedMessages = React.useCallback(() => {
    const now = new Date();
    for (const msg of messagesRef.current) {
      if (msg.snoozedUntil && new Date(msg.snoozedUntil) <= now) {
        snoozeMessageRef.current(
          { uid: msg.uid, mailboxAddress: msg.mailboxAddress },
          undefined,
        );
      }
    }
  }, []);

  // Parse query intent once, used by both local filter and fetch logic
  const intent = React.useMemo(() => parseQueryIntent(query), [query]);

  // Filter Jazz-cached messages by parsed intent, plus include any
  // server-matched keys from previous IMAP searches
  const localSearchResults = React.useMemo(() => {
    if (!query) return messages;
    const intentFiltered = filterByIntent(messages, intent);
    // For keyword searches, also include server-matched results
    if (intent.type === "keyword" && serverMatchedKeys.size > 0) {
      const intentKeys = new Set(
        intentFiltered.map((m) => `${m.mailboxAddress}:${m.uid}`),
      );
      const extra = messages.filter(
        (m) =>
          !intentKeys.has(`${m.mailboxAddress}:${m.uid}`) &&
          serverMatchedKeys.has(`${m.mailboxAddress}:${m.uid}`),
      );
      return [...intentFiltered, ...extra];
    }
    return intentFiltered;
  }, [messages, query, intent, serverMatchedKeys]);

  const localSearchResultsRef = React.useRef(localSearchResults);
  React.useEffect(() => {
    localSearchResultsRef.current = localSearchResults;
  }, [localSearchResults]);

  // Show cached Jazz messages immediately once Jazz has loaded
  React.useEffect(() => {
    if (isJazzLoaded && messages.length > 0) {
      setIsLoading(false);
    }
  }, [isJazzLoaded, messages.length]);

  const getAllEmails = React.useCallback(
    async (includeFolders: boolean) => {
      if (isFetchingRef.current) return;
      isFetchingRef.current = true;
      const requestId = ++requestIdRef.current;
      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      const hasCachedMessages = messagesRef.current.length > 0;
      if (!hasCachedMessages) setIsLoading(true);

      try {
        if (!hasCachedMessages) {
          // No cached data — initial full fetch from IMAP
          const response = await fetch(
            `/api/mail/search?query=&includeFolders=${includeFolders}`,
            {
              cache: "no-store",
              signal: abortController.signal,
            },
          );
          if (!response.ok || requestIdRef.current !== requestId) return;
          const payload = await response.json();
          syncInboxRef.current({
            messages: payload.emails ?? [],
            folders:
              payload.folders ?? (includeFolders ? [] : foldersRef.current),
            mailboxes: mailboxesRef.current,
          });
          if (includeFolders) hasFetchedFoldersRef.current = true;
        } else {
          // Has cached data — incremental UID watermark fetch
          const uniqueMailboxes = [
            ...new Set(messagesRef.current.map((m) => m.mailboxAddress)),
          ];
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
              {
                cache: "no-store",
                signal: abortController.signal,
              },
            );
            if (!response.ok || requestIdRef.current !== requestId) continue;
            const payload = await response.json();
            if ((payload.emails ?? []).length > 0) {
              syncInboxRef.current({
                messages: payload.emails,
                folders: [],
                mailboxes: mailboxesRef.current,
              });
            }
          }
        }

        // For keyword searches: if Jazz cache has sparse results,
        // fall back to IMAP server search
        if (
          intent.type === "keyword" &&
          localSearchResultsRef.current.length < SPARSE_THRESHOLD &&
          requestIdRef.current === requestId
        ) {
          const response = await fetch(
            `/api/mail/search?query=${encodeURIComponent(query)}&includeFolders=false`,
            {
              cache: "no-store",
              signal: abortController.signal,
            },
          );
          if (response.ok && requestIdRef.current === requestId) {
            const payload = await response.json();
            const serverEmails = payload.emails ?? [];
            if (serverEmails.length > 0) {
              syncInboxRef.current({
                messages: serverEmails,
                folders: [],
                mailboxes: mailboxesRef.current,
              });
              setServerMatchedKeys(
                new Set(
                  serverEmails.map(
                    (e: { mailboxAddress: string; uid: string }) =>
                      `${e.mailboxAddress}:${e.uid}`,
                  ),
                ),
              );
            }
          }
        }

        // Resurface snoozed emails
        resurfaceSnoozedMessages();

        // Sync scheduled emails
        if (requestIdRef.current === requestId) {
          const scheduledResponse = await fetch("/api/mail/scheduled", {
            signal: abortController.signal,
          });
          if (scheduledResponse.ok && requestIdRef.current === requestId) {
            const { scheduled } = await scheduledResponse.json();
            syncScheduledEmailsRef.current(scheduled ?? []);
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
    },
    [query, intent, resurfaceSnoozedMessages],
  );

  React.useEffect(() => {
    if (!isJazzLoaded) return;

    setServerMatchedKeys(new Set());
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
  }, [getAllEmails, query, isJazzLoaded]);

  return (
    <InboxClient
      emails={localSearchResults}
      isLoading={isLoading}
      query={query}
    />
  );
}
