"use client";
import InboxClient from "@/components/inbox/inbox-client";
import { useAuth } from "@clerk/nextjs";
import { useSearchParams } from "next/navigation";
import React from "react";
import { useJazzInboxState } from "@/providers/jazz-provider";

export default function Inbox() {
  const { getToken } = useAuth();
  const { messages, folders, mailboxes, syncInbox } = useJazzInboxState();
  const searchParams = useSearchParams();
  const query = searchParams.get("query")?.trim() ?? "";

  const getAllEmails = async () => {
    const token = await getToken();

    const response = await fetch(
      `/api/mail/search?query=${encodeURIComponent(query)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );

    const payload = await response.json();
    syncInbox({
      messages: payload.emails ?? [],
      folders: payload.folders ?? folders,
      mailboxes,
    });
  };

  React.useEffect(() => {
    getAllEmails();
  }, [query]);

  return <InboxClient emails={messages} />;
}
