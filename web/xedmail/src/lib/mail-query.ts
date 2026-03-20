import type { SearchObject } from "imapflow";

type MsParseResponse = {
  intent?: string;
  filters?: {
    status?: string;
    from?: string;
    date?: string;
  };
};

const MS_PARSER_URL = process.env.MS_PARSER_URL ?? "http://127.0.0.1:8000/parse";
const MS_PARSER_TIMEOUT_MS = 3000;

function hasStructuredFilters(search: SearchObject) {
  return Boolean(
    typeof search.seen === "boolean" ||
      search.from ||
      search.on ||
      search.subject,
  );
}

// Matches natural language queries that mean "show all mail"
const ALL_INTENT_PATTERN = /\b(all|every|show|get|list|display)\b.*\b(email|mail|message|inbox)\b/i;

// Words that are clearly filler — if removing them leaves nothing meaningful,
// the user just wants all mail.
const FILLER_WORDS = /\b(my|me|the|all|every|everything|show|get|list|display|find|search|for|emails?|mail|messages?|inbox|please)\b/gi;

function isAllIntent(query: string): boolean {
  if (!query) return true;
  if (ALL_INTENT_PATTERN.test(query)) return true;
  // Strip filler words; if nothing meaningful remains, it's an all-intent
  const stripped = query.replace(FILLER_WORDS, "").trim();
  return stripped.length === 0;
}

function buildFallbackSearchObject(query: string): SearchObject {
  const normalized = query.trim().toLowerCase();

  if (isAllIntent(normalized)) {
    return { all: true };
  }

  const search: SearchObject = { all: true };

  // Match "unread" anywhere, including "unread emails", "show unread", etc.
  if (/\bunread\b/.test(normalized)) {
    search.seen = false;
  } else if (/\bread\b/.test(normalized) && !/\bread[yings]/.test(normalized)) {
    // Match "read" but not "ready", "reading", "reader", "reads"
    search.seen = true;
  }

  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  if (/\btoday\b/.test(normalized)) {
    search.on = today;
  } else if (/\byesterday\b/.test(normalized)) {
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

  if (!hasStructuredFilters(search)) {
    // Only use gmraw for short keyword-like queries (1-3 words) that look
    // like intentional search terms, not natural language phrases.
    const words = normalized.split(/\s+/);
    if (words.length <= 3) {
      search.gmraw = query;
    }
    // For longer phrases that didn't match any filter, return all results
    // rather than searching for the literal phrase which rarely works.
  }

  return search;
}

function applyDateFilter(search: SearchObject, rawDate: string) {
  const normalized = rawDate.trim().toLowerCase();
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  if (normalized.includes("today")) {
    search.on = today;
    return;
  }

  if (normalized.includes("yesterday")) {
    const yesterday = new Date(today);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    search.on = yesterday;
  }
}

export async function buildSearchObject(query: string): Promise<SearchObject> {
  const trimmedQuery = query.trim();
  if (isAllIntent(trimmedQuery)) {
    return { all: true };
  }

  const fallback = buildFallbackSearchObject(trimmedQuery);
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), MS_PARSER_TIMEOUT_MS);

  try {
    const response = await fetch(MS_PARSER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: trimmedQuery }),
      cache: "no-store",
      signal: abortController.signal,
    });

    if (!response.ok) {
      return fallback;
    }

    const payload = (await response.json()) as MsParseResponse;
    if (payload.intent !== "search_emails") {
      return fallback;
    }

    const search: SearchObject = { all: true };

    if (payload.filters?.status === "unread") {
      search.seen = false;
    } else if (payload.filters?.status === "read") {
      search.seen = true;
    }

    if (payload.filters?.from) {
      search.from = payload.filters.from;
    }

    if (payload.filters?.date) {
      applyDateFilter(search, payload.filters.date);
    }

    if (fallback.subject) {
      search.subject = fallback.subject;
    }

    if (!hasStructuredFilters(search)) {
      return fallback;
    }

    return search;
  } catch {
    return fallback;
  } finally {
    clearTimeout(timeout);
  }
}
