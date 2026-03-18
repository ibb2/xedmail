import type { SearchObject } from "imapflow";

export function buildSearchObject(query: string): SearchObject {
  const normalized = query.trim().toLowerCase();

  if (!normalized) {
    return { all: true };
  }

  const search: SearchObject = { all: true };

  if (normalized.includes(" unread") || normalized.startsWith("unread")) {
    search.seen = false;
  } else if (normalized.includes(" read") || normalized.startsWith("read")) {
    search.seen = true;
  }

  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  if (normalized.includes("today")) {
    search.on = today;
  } else if (normalized.includes("yesterday")) {
    const yesterday = new Date(today);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    search.on = yesterday;
  }

  const fromMatch = /\bfrom\s+([\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/.exec(query);
  if (fromMatch?.[1]) {
    search.from = fromMatch[1];
  }

  const subjectMatch = /\bsubject\s+"([^"]+)"/.exec(query);
  if (subjectMatch?.[1]) {
    search.subject = subjectMatch[1];
  }

  // Gmail supports gmraw and it maps well to natural-language style queries.
  // For Gmail mailboxes we set it as a fallback so users can type flexible search text.
  search.gmraw = query;

  return search;
}
