"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

export type Contact = { name: string; address: string };

type TokenType = "from-locked" | "from-keyword" | "status" | "date" | "keyword";
type Token = { type: TokenType; text: string };

const STATUS_WORDS = new Set(["unread", "read"]);
const DATE_WORDS = new Set(["today", "yesterday"]);

export function parseTokens(
  value: string,
  lockedAddresses: Set<string>,
): Token[] {
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
        const type = lockedAddresses.has(addressPart)
          ? "from-locked"
          : "from-keyword";
        tokens.push({ type, text: word });
      } else {
        // "from: alice" — keyword and address are separate words
        const next = words[i + 1] ?? "";
        const type =
          next && lockedAddresses.has(next) ? "from-locked" : "from-keyword";
        tokens.push({ type, text: next ? `from: ${next}` : "from:" });
        if (next) i++;
      }
    } else if (STATUS_WORDS.has(wordLow)) {
      tokens.push({ type: "status", text: word });
    } else if (DATE_WORDS.has(wordLow)) {
      tokens.push({ type: "date", text: word });
    } else if (
      wordLow === "last" &&
      /^\d+$/.test(words[i + 1] ?? "") &&
      words[i + 2]?.toLowerCase() === "days"
    ) {
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
const TOKEN_STYLES: Record<TokenType, { color: string; background?: string }> =
  {
    "from-locked": { color: "#93c5fd", background: "rgba(96,165,250,0.1)" },
    "from-keyword": { color: "#93c5fd" },
    status: { color: "#fbbf24", background: "rgba(251,191,36,0.1)" },
    date: { color: "#86efac", background: "rgba(134,239,172,0.1)" },
    keyword: { color: "rgba(229,226,225,0.5)" },
  };

// Size-specific layout constants
const SIZE_CONFIG = {
  lg: {
    paddingTop: 18,
    paddingRight: 24,
    paddingBottom: 18,
    paddingLeft: 44,
    fontSize: 16,
    iconLeft: 14,
    borderRadius: "1rem",
  },
  sm: {
    paddingTop: 8,
    paddingRight: 16,
    paddingBottom: 8,
    paddingLeft: 36,
    fontSize: 14,
    iconLeft: 10,
    borderRadius: "9999px",
  },
} as const;

type SmartSearchBarProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  contacts: Contact[];
  placeholder?: string;
  size: "lg" | "sm";
  showKbdHint?: boolean;
  inputRef?: React.RefObject<HTMLInputElement | null>;
};

export function SmartSearchBar({
  value,
  onChange,
  onSubmit,
  contacts,
  placeholder,
  size,
  showKbdHint,
  inputRef: externalRef,
}: SmartSearchBarProps) {
  const internalRef = useRef<HTMLInputElement>(null);
  const inputRef = externalRef ?? internalRef;

  const [lockedAddresses, setLockedAddresses] = useState<Set<string>>(
    () => new Set(),
  );
  const [ghostText, setGhostText] = useState("");
  const [ghostIndex, setGhostIndex] = useState(0);
  const [ghostLeft, setGhostLeft] = useState(0);
  const canvasCtx = useRef<CanvasRenderingContext2D | null>(null);
  const isMobile = useRef(false);

  const cfg = SIZE_CONFIG[size];

  // --- Initialise on mount ---
  useEffect(() => {
    isMobile.current = window.matchMedia("(pointer: coarse)").matches;

    const initial = new Set<string>();
    const words = value.split(/\s+/);
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const addr = w.toLowerCase().startsWith("from:")
        ? w.slice(5)
        : w === "from:"
          ? words[i + 1]
          : null;
      if (addr && addr.includes("@") && addr.split("@")[1]?.includes(".")) {
        initial.add(addr);
      }
    }
    setLockedAddresses(initial);

    if (inputRef.current) {
      const style = getComputedStyle(inputRef.current);
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d")!;
      ctx.font = `${style.fontWeight} ${cfg.fontSize}px Inter, sans-serif`;
      canvasCtx.current = ctx;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Derive ghost text from current value + contacts ---
  const { ghostSuggestions, typedPartial } = useMemo(() => {
    const tokens = parseTokens(value, lockedAddresses);
    const last = tokens[tokens.length - 1];
    if (!last || last.type !== "from-keyword")
      return { ghostSuggestions: [], typedPartial: "" };
    const partial = last.text.toLowerCase().startsWith("from:")
      ? last.text.slice(last.text.indexOf(":") + 1).trimStart()
      : "";
    if (!partial) return { ghostSuggestions: [], typedPartial: "" };
    const matches = contacts.filter(
      (c) =>
        c.address.toLowerCase().startsWith(partial) ||
        c.name.toLowerCase().startsWith(partial),
    );
    return { ghostSuggestions: matches, typedPartial: partial };
  }, [value, lockedAddresses, contacts]);

  useEffect(() => {
    setGhostIndex((i) => Math.min(i, Math.max(0, ghostSuggestions.length - 1)));
  }, [ghostSuggestions.length]);

  useEffect(() => {
    if (isMobile.current || ghostSuggestions.length === 0) {
      setGhostText("");
      return;
    }
    const best = ghostSuggestions[ghostIndex];
    if (!best) {
      setGhostText("");
      return;
    }
    setGhostText(best.address.slice(typedPartial.length));
  }, [ghostSuggestions, ghostIndex, typedPartial]);

  // Measure ghost span left position — runs after every render so scrollLeft is always fresh
  useEffect(() => {
    if (!ghostText || !canvasCtx.current || !inputRef.current) return;
    const width = canvasCtx.current.measureText(value).width;
    setGhostLeft(cfg.paddingLeft + width - inputRef.current.scrollLeft);
  });

  const tokens = useMemo(
    () => parseTokens(value, lockedAddresses),
    [value, lockedAddresses],
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const ghostActive = ghostText.length > 0 && ghostSuggestions.length > 0;

    if (e.key === "Tab" && ghostActive) {
      e.preventDefault();
      e.nativeEvent.stopImmediatePropagation();
      const best = ghostSuggestions[ghostIndex];
      if (!best) return;
      const fullAddress = best.address;
      const updated = value.replace(
        new RegExp(`(from:\\s*)${escapeRegExp(typedPartial)}$`, "i"),
        `from: ${fullAddress}`,
      );
      onChange(updated);
      setLockedAddresses((prev) => new Set([...prev, fullAddress]));
      setGhostText("");
      return;
    }

    if (e.key === "ArrowUp") {
      if (ghostActive) {
        e.preventDefault();
        e.nativeEvent.stopImmediatePropagation();
        setGhostIndex(
          (i) => (i - 1 + ghostSuggestions.length) % ghostSuggestions.length,
        );
      }
      return;
    }

    if (e.key === "ArrowDown") {
      if (ghostActive) {
        e.preventDefault();
        e.nativeEvent.stopImmediatePropagation();
        setGhostIndex((i) => (i + 1) % ghostSuggestions.length);
      }
      return;
    }

    if (e.key === "Escape") {
      if (ghostActive) {
        e.preventDefault();
        e.nativeEvent.stopImmediatePropagation();
        setGhostText("");
      }
      return;
    }

    if (e.key === " " && typedPartial) {
      if (
        typedPartial.includes("@") &&
        typedPartial.split("@")[1]?.includes(".")
      ) {
        setLockedAddresses((prev) => new Set([...prev, typedPartial]));
      }
    }

    if (e.key === "Backspace") {
      const next = value.slice(0, -1);
      setLockedAddresses((prev) => {
        const updated = new Set(prev);
        for (const addr of prev) {
          if (!next.includes(addr)) updated.delete(addr);
        }
        return updated;
      });
    }

    if (e.key === "Enter") {
      e.preventDefault();
      onSubmit(value.trim());
    }
  };

  return (
    <div style={{ position: "relative", width: "100%" }}>
      {/* Search icon */}
      <span
        className="material-symbols-outlined"
        style={{
          position: "absolute",
          left: cfg.iconLeft,
          top: "50%",
          transform: "translateY(-50%)",
          color: "#FFB77B",
          fontSize: size === "lg" ? 18 : 16,
          pointerEvents: "none",
          zIndex: 4,
        }}
      >
        search
      </span>

      {/* Mirror div */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          paddingTop: cfg.paddingTop,
          paddingRight: cfg.paddingRight,
          paddingBottom: cfg.paddingBottom,
          paddingLeft: cfg.paddingLeft,
          fontSize: cfg.fontSize,
          fontFamily: "Inter, sans-serif",
          whiteSpace: "pre",
          overflow: "hidden",
          pointerEvents: "none",
          zIndex: 1,
          display: "flex",
          alignItems: "center",
          borderRadius: cfg.borderRadius,
        }}
      >
        <span style={{ whiteSpace: "pre" }}>
          {tokens.map((tok, idx) => {
            const style = TOKEN_STYLES[tok.type];
            return (
              <React.Fragment key={idx}>
                <span
                  style={{
                    color: style.color,
                    background: style.background,
                    padding: style.background ? "2px 4px" : undefined,
                    borderRadius: style.background ? 4 : undefined,
                  }}
                >
                  {tok.text}
                </span>
                {idx < tokens.length - 1 ? " " : ""}
              </React.Fragment>
            );
          })}
        </span>
      </div>

      {/* Ghost span */}
      {ghostText && !isMobile.current && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            top: "50%",
            left: ghostLeft,
            transform: "translateY(-50%)",
            fontSize: cfg.fontSize,
            fontFamily: "Inter, sans-serif",
            color: "rgba(229,226,225,0.2)",
            pointerEvents: "none",
            zIndex: 3,
            whiteSpace: "pre",
          }}
        >
          {ghostText}
        </span>
      )}

      {/* Real input */}
      <input
        ref={inputRef as React.RefObject<HTMLInputElement>}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className="w-full outline-none"
        style={{
          position: "relative",
          zIndex: 2,
          background: "#1C1B1B",
          border: size === "sm" ? "1px solid rgba(82,68,57,0.3)" : "none",
          borderRadius: cfg.borderRadius,
          paddingTop: cfg.paddingTop,
          paddingRight: cfg.paddingRight,
          paddingBottom: cfg.paddingBottom,
          paddingLeft: cfg.paddingLeft,
          fontSize: cfg.fontSize,
          color: "transparent",
          caretColor: "#FFB77B",
          fontFamily: "Inter, sans-serif",
          width: size === "sm" ? 192 : "100%",
        }}
      />

      {/* ⌘K hint badge */}
      {showKbdHint && (
        <kbd
          style={{
            position: "absolute",
            right: 16,
            top: "50%",
            transform: "translateY(-50%)",
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 9,
            padding: "3px 6px",
            borderRadius: "0.375rem",
            background: "#353535",
            color: "#D8C3B4",
            border: "1px solid rgba(82,68,57,0.5)",
            pointerEvents: "none",
            zIndex: 4,
          }}
        >
          ⌘ K
        </kbd>
      )}
    </div>
  );
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
