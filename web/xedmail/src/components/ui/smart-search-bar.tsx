"use client";

import React, { useEffect, useRef, useState, useMemo } from "react";

export type Contact = { name: string; address: string };

type TokenType = "from-locked" | "from-keyword" | "status" | "date" | "keyword";
type Token = { type: TokenType; text: string };

const STATUS_WORDS = new Set(["unread", "read"]);
const DATE_WORDS = new Set(["today", "yesterday"]);

export function parseTokens(value: string, lockedAddresses: Set<string>): Token[] {
  if (!value) return [];
  const tokens: Token[] = [];
  const words = value.split(" ");
  let i = 0;
  while (i < words.length) {
    const word = words[i];
    const wordLow = word.toLowerCase();

    if (wordLow.startsWith("from:")) {
      const addressPart = word.slice(5); // text after "from:"
      if (addressPart) {
        // "from:alice@x.com" — all in one word
        const type = lockedAddresses.has(addressPart) ? "from-locked" : "from-keyword";
        tokens.push({ type, text: word });
      } else {
        // "from: alice" — keyword and address are separate words
        const next = words[i + 1] ?? "";
        const type = next && lockedAddresses.has(next) ? "from-locked" : "from-keyword";
        tokens.push({ type, text: next ? `from: ${next}` : "from:" });
        if (next) i++;
      }
    } else if (STATUS_WORDS.has(wordLow)) {
      tokens.push({ type: "status", text: word });
    } else if (DATE_WORDS.has(wordLow)) {
      tokens.push({ type: "date", text: word });
    } else if (wordLow === "last" && /^\d+$/.test(words[i + 1] ?? "") && words[i + 2]?.toLowerCase() === "days") {
      // Multi-word "last N days" — consume three words as one token
      const text = `${word} ${words[i + 1]} ${words[i + 2]}`;
      tokens.push({ type: "date", text });
      i += 2;
    } else if (word) {
      tokens.push({ type: "keyword", text: word });
    }
    i++;
  }
  return tokens;
}

// Colours per token type
const TOKEN_STYLES: Record<TokenType, { color: string; background?: string }> = {
  "from-locked":  { color: "#93c5fd", background: "rgba(96,165,250,0.1)" },
  "from-keyword": { color: "#93c5fd" },
  "status":       { color: "#fbbf24", background: "rgba(251,191,36,0.1)" },
  "date":         { color: "#86efac", background: "rgba(134,239,172,0.1)" },
  "keyword":      { color: "rgba(229,226,225,0.5)" },
};

// Placeholder export so the file compiles — full component added in Task 4
export function SmartSearchBar() {
  return null;
}
