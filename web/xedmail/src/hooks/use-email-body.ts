"use client";

import React from "react";
import { db } from "@/lib/dexie";
import { decompress, storeBody, evict } from "@/lib/body-cache";

export type AttachmentManifest = {
  partId: string;
  filename: string;
  size: number;
  mimeType: string;
};

export function useEmailBody(id: string | null) {
  const [body, setBody] = React.useState<string | null>(null);
  const [attachments, setAttachments] = React.useState<AttachmentManifest[]>(
    [],
  );
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<Error | null>(null);

  React.useEffect(() => {
    if (!id) return;
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      try {
        // Cache hit — body was synced during backfill or a previous open
        const cached = await db.bodies.get(id!);
        if (cached) {
          await db.bodies.update(id!, { lastAccessed: Date.now() });
          const text = await decompress(cached.compressedData);
          if (!cancelled) {
            setBody(text);
            setAttachments(JSON.parse(cached.attachmentsJson ?? "[]"));
            setLoading(false);
          }
          return;
        }

        // Cache miss — fetch full source via Next.js proxy (fallback)
        const res = await fetch(`/api/mail/body/${id}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { body: rawBody, attachments: atts } = await res.json();

        if (!cancelled) {
          setBody(rawBody);
          setAttachments(atts ?? []);
        }

        if (cancelled) return;

        await storeBody(id!, rawBody, atts ?? []);
        void evict();
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [id]);

  return { body, attachments, loading, error };
}
