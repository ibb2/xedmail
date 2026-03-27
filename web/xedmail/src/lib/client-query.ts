/**
 * Client-side query parser and filter utilities.
 * parseQueryIntent handles well-defined structured patterns instantly (no API).
 * FastAPI is called separately for natural-language keyword queries.
 */

import type { EmailMetadata } from "@/lib/dexie";

export type QueryIntent =
  | { type: "all" }
  | { type: "status"; seen: boolean }
  | { type: "date"; date: Date }
  | { type: "from"; address: string }
  | { type: "keyword"; text: string };

const ALL_INTENT_PATTERN =
  /\b(all|every|show|get|list|display)\b.*\b(email|mail|message|inbox)\b/i;

const FILLER_WORDS =
  /\b(my|me|the|all|every|everything|show|get|list|display|find|search|for|emails?|mail|messages?|inbox|please)\b/gi;

function isAllIntent(query: string): boolean {
  if (!query) return true;
  if (ALL_INTENT_PATTERN.test(query)) return true;
  return query.replace(FILLER_WORDS, "").trim().length === 0;
}

export function parseQueryIntent(query: string): QueryIntent {
  const normalized = query.trim().toLowerCase();

  if (isAllIntent(normalized)) return { type: "all" };

  if (/\bunread\b/.test(normalized)) return { type: "status", seen: false };

  if (/\bread\b/.test(normalized) && !/\bread[yings]/.test(normalized))
    return { type: "status", seen: true };

  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  if (/\btoday\b/.test(normalized)) return { type: "date", date: today };

  if (/\byesterday\b/.test(normalized)) {
    const yesterday = new Date(today);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    return { type: "date", date: yesterday };
  }

  // "from:john", "from:john@x.com", "from john@x.com"
  const fromMatch = /\bfrom[:\s]+(\S+)/.exec(normalized);
  if (fromMatch?.[1]) return { type: "from", address: fromMatch[1] };

  return { type: "keyword", text: normalized };
}

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
