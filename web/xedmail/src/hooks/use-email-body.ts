"use client";

import React from "react";
import { db } from "@/lib/dexie";

export type AttachmentManifest = {
  partId: string;
  filename: string;
  size: number;
  mimeType: string;
};

const MAX_CACHE_BYTES = Number(process.env.NEXT_PUBLIC_MAX_BODY_CACHE_MB ?? 500) * 1024 * 1024;

async function compress(text: string): Promise<{ data: Uint8Array; byteSize: number }> {
  const stream = new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); },
  }).pipeThrough(new CompressionStream("gzip"));
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) chunks.push(chunk);
  const data = new Uint8Array(chunks.reduce((a, b) => a + b.byteLength, 0));
  let offset = 0;
  for (const c of chunks) { data.set(c, offset); offset += c.byteLength; }
  return { data, byteSize: data.byteLength };
}

async function decompress(data: Uint8Array): Promise<string> {
  const stream = new ReadableStream({
    start(c) { c.enqueue(data); c.close(); },
  }).pipeThrough(new DecompressionStream("gzip"));
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) chunks.push(chunk);
  const all = new Uint8Array(chunks.reduce((a, b) => a + b.byteLength, 0));
  let offset = 0;
  for (const c of chunks) { all.set(c, offset); offset += c.byteLength; }
  return new TextDecoder().decode(all);
}

async function evict() {
  const total = await db.syncState.get("totalBodyBytes");
  let totalBytes = total ? JSON.parse(total.value) as number : 0;
  if (totalBytes <= MAX_CACHE_BYTES) return;
  const bodies = await db.bodies.orderBy("lastAccessed").toArray();
  for (const b of bodies) {
    if (totalBytes <= MAX_CACHE_BYTES) break;
    await db.bodies.delete(b.id);
    totalBytes -= b.byteSize;
  }
  await db.syncState.put({ key: "totalBodyBytes", value: JSON.stringify(Math.max(0, totalBytes)) });
}

export function useEmailBody(id: string | null) {
  const [body, setBody] = React.useState<string | null>(null);
  const [attachments, setAttachments] = React.useState<AttachmentManifest[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<Error | null>(null);

  React.useEffect(() => {
    if (!id) return;
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      try {
        // Cache hit
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

        // Cache miss — fetch via Next.js proxy
        const res = await fetch(`/api/mail/body/${id}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { body: rawBody, attachments: atts } = await res.json();

        if (!cancelled) {
          setBody(rawBody);
          setAttachments(atts ?? []);
        }

        // Cache if ≤ 5 MB compressed
        const { data, byteSize } = await compress(rawBody);
        const FIVE_MB = 5 * 1024 * 1024;
        if (byteSize <= FIVE_MB) {
          await db.bodies.put({ id: id!, compressedData: data, lastAccessed: Date.now(), byteSize, attachmentsJson: JSON.stringify(atts ?? []) });
          const prev = await db.syncState.get("totalBodyBytes");
          const prevBytes = prev ? JSON.parse(prev.value) as number : 0;
          await db.syncState.put({ key: "totalBodyBytes", value: JSON.stringify(prevBytes + byteSize) });
          void evict();
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [id]);

  return { body, attachments, loading, error };
}
