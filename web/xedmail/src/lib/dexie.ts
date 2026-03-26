import Dexie, { type EntityTable } from "dexie";

export type EmailMetadata = {
  id: string;
  mailboxId: string;
  uid: number;
  threadId: string;
  subject: string;
  fromName: string;
  fromAddress: string;
  date: number;
  snippet: string;
  isRead: boolean;
  isStarred: boolean;
  labels: string[];
  hasAttachments: boolean;
};

export type CachedBody = {
  id: string;
  compressedData: Uint8Array;
  lastAccessed: number;
  byteSize: number;
  attachmentsJson?: string;
};

export type SearchIndexRow = {
  field: string;
  snapshot: string;
};

export type SyncStateRow = {
  key: string;
  value: string; // JSON-serialised
};

export type RecentSearch = {
  id?: number;
  query: string;
  searchedAt: number;
};

class XedmailDB extends Dexie {
  emails!: EntityTable<EmailMetadata, "id">;
  bodies!: EntityTable<CachedBody, "id">;
  searchIndex!: EntityTable<SearchIndexRow, "field">;
  syncState!: EntityTable<SyncStateRow, "key">;
  recentSearches!: EntityTable<RecentSearch, "id">;

  constructor() {
    super("xedmail");
    this.version(1).stores({
      emails: "&id, mailboxId, date, fromAddress, isRead, threadId",
      bodies: "&id, lastAccessed, byteSize",
      searchIndex: "&field, snapshot",
      syncState: "&key, value",
      recentSearches: "++id, searchedAt",
    });
  }
}

export const db = new XedmailDB();

// --- syncState helpers ---
export async function getSyncState<T>(key: string, fallback: T): Promise<T> {
  const row = await db.syncState.get(key);
  return row ? (JSON.parse(row.value) as T) : fallback;
}

export async function setSyncState(key: string, value: unknown): Promise<void> {
  await db.syncState.put({ key, value: JSON.stringify(value) });
}
