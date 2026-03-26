import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/lib/dexie";
import type { EmailMetadata } from "@/lib/dexie";

export type { EmailMetadata };

export function useInboxEmails(mailboxId?: string): EmailMetadata[] {
  return useLiveQuery(
    () => mailboxId
      ? db.emails.where("mailboxId").equals(mailboxId).sortBy("date")
      : db.emails.orderBy("date").toArray(),
    [mailboxId],
    [],
  ) ?? [];
}

export function useAllInboxEmails(): EmailMetadata[] {
  return useLiveQuery(
    () => db.emails.orderBy("date").reverse().toArray(),
    [],
    [],
  ) ?? [];
}
