import { Document } from "flexsearch";
import type { EmailMetadata } from "@/lib/dexie";
import { db } from "@/lib/dexie";

type IndexedEmail = Pick<
  EmailMetadata,
  "id" | "subject" | "fromName" | "fromAddress" | "snippet"
>;

let index: InstanceType<typeof Document<IndexedEmail>> | null = null;
let addedSinceSnapshot = 0;
const SNAPSHOT_EVERY = 500;

function getIndex() {
  if (!index) {
    index = new Document<IndexedEmail>({
      document: {
        id: "id",
        index: [
          { field: "subject", tokenize: "forward" },
          { field: "fromName", tokenize: "forward" },
          { field: "fromAddress", tokenize: "forward" },
          { field: "snippet", tokenize: "forward" },
        ],
      },
      cache: true,
    });
  }
  return index;
}

export async function rehydrateIndex(): Promise<void> {
  const idx = getIndex();
  const rows = await db.searchIndex.toArray();
  for (const row of rows) {
    await (idx as any).import(row.field, row.snapshot);
  }
}

export async function addToIndex(emails: EmailMetadata[]): Promise<void> {
  const idx = getIndex();
  for (const e of emails) {
    idx.add({
      id: e.id,
      subject: e.subject,
      fromName: e.fromName,
      fromAddress: e.fromAddress,
      snippet: e.snippet,
    });
  }
  addedSinceSnapshot += emails.length;
  if (addedSinceSnapshot >= SNAPSHOT_EVERY) {
    addedSinceSnapshot = 0;
    void persistSnapshot();
  }
}

export async function removeFromIndex(id: string): Promise<void> {
  getIndex().remove(id);
}

async function persistSnapshot(): Promise<void> {
  const idx = getIndex();
  const fields = ["subject", "fromName", "fromAddress", "snippet"];
  for (const field of fields) {
    await new Promise<void>((resolve) => {
      (idx as any).export(field, async (key: string, data: string) => {
        if (data !== undefined)
          await db.searchIndex.put({ field: key, snapshot: data });
        resolve();
      });
    });
  }
}

export function searchIndex(query: string): string[] {
  if (!query.trim()) return [];
  const results = getIndex().search(query, { limit: 200, enrich: false });
  const ids = new Set<string>();
  for (const r of results) {
    for (const id of r.result as string[]) ids.add(id);
  }
  return [...ids];
}
