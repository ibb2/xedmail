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

function buildFallbackSearchObject(query: string): SearchObject {
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

  if (!hasStructuredFilters(search)) {
    // Fall back to Gmail raw queries only when we do not have a structured filter set.
    search.gmraw = query;
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
  if (!trimmedQuery) {
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
