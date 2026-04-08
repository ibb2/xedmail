/**
 * Shared compress/decompress/store utilities for email body caching.
 * Used by both sync-provider (bulk backfill writes) and use-email-body (on-demand fetch).
 */

import { db, getSyncState, setSyncState } from "@/lib/dexie";
import type { AttachmentManifest } from "@/hooks/use-email-body";

export const MAX_CACHE_BYTES =
  Number(process.env.NEXT_PUBLIC_MAX_BODY_CACHE_MB ?? 2048) * 1024 * 1024;

export async function compress(
  text: string,
): Promise<{ data: Uint8Array; byteSize: number }> {
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  }).pipeThrough(new CompressionStream("gzip"));
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>)
    chunks.push(chunk);
  const data = new Uint8Array(
    chunks.reduce((a, b) => a + b.byteLength, 0),
  );
  let offset = 0;
  for (const c of chunks) {
    data.set(c, offset);
    offset += c.byteLength;
  }
  return { data, byteSize: data.byteLength };
}

export async function decompress(data: Uint8Array): Promise<string> {
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(data);
      c.close();
    },
  }).pipeThrough(new DecompressionStream("gzip"));
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>)
    chunks.push(chunk);
  const all = new Uint8Array(chunks.reduce((a, b) => a + b.byteLength, 0));
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

export async function evict(): Promise<void> {
  const totalBytes = await getSyncState<number>("totalBodyBytes", 0);
  if (totalBytes <= MAX_CACHE_BYTES) return;
  const bodies = await db.bodies.orderBy("lastAccessed").toArray();
  let remaining = totalBytes;
  for (const b of bodies) {
    if (remaining <= MAX_CACHE_BYTES) break;
    await db.bodies.delete(b.id);
    remaining -= b.byteSize;
  }
  await setSyncState("totalBodyBytes", Math.max(0, remaining));
}

export async function storeBody(
  id: string,
  text: string,
  attachments: AttachmentManifest[] = [],
): Promise<void> {
  const { data, byteSize } = await compress(text);
  await db.bodies.put({
    id,
    compressedData: data,
    lastAccessed: Date.now(),
    byteSize,
    attachmentsJson: JSON.stringify(attachments),
  });
  const prev = await getSyncState<number>("totalBodyBytes", 0);
  await setSyncState("totalBodyBytes", prev + byteSize);
}
