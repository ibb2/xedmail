/**
 * Client-side filter utilities for applying FastAPI-parsed intents
 * against the Dexie email cache.
 */

import type { EmailMetadata } from "@/lib/dexie";

export type QueryIntent =
  | { type: "all" }
  | { type: "status"; seen: boolean }
  | { type: "date"; date: Date }
  | { type: "from"; address: string }
  | { type: "keyword"; text: string };

export function filterByIntent(
  messages: EmailMetadata[],
  intent: QueryIntent,
): EmailMetadata[] {
  switch (intent.type) {
    case "all":
      return messages;

    case "status":
      return messages.filter((m) => m.isRead === intent.seen);

    case "date": {
      const targetDate = intent.date.toISOString().slice(0, 10);
      return messages.filter(
        (m) => new Date(m.date).toISOString().slice(0, 10) === targetDate,
      );
    }

    case "from":
      return messages.filter(
        (m) =>
          m.fromAddress.toLowerCase().includes(intent.address) ||
          m.fromName.toLowerCase().includes(intent.address),
      );

    case "keyword":
      return messages.filter(
        (m) =>
          m.subject.toLowerCase().includes(intent.text) ||
          m.fromName.toLowerCase().includes(intent.text) ||
          m.fromAddress.toLowerCase().includes(intent.text),
      );
  }
}
