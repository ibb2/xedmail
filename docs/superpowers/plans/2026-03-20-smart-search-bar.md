# Smart Search Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a `SmartSearchBar` component with inline token highlighting, ghost-text contact completion, `⌘K` focus, and hotkeys-js keyboard shortcuts replacing the current vanilla `addEventListener` approach.

**Architecture:** A shared `SmartSearchBar` component uses a real `<input>` (transparent text) stacked over a mirror `div` that renders coloured token spans, plus an absolutely-positioned ghost span for contact completion. `hotkeys-js` manages all keyboard shortcuts globally (homepage `⌘K`) and scoped (inbox navigation). Two new files: `src/lib/contacts.ts` (contact extraction) and `src/components/ui/smart-search-bar.tsx` (the component). Two existing files updated: `page.tsx` and `inbox-client.tsx`.

**Tech Stack:** React 19, Next.js 15, TypeScript, hotkeys-js, canvas API (text measurement), Jazz state (`messages` → contact extraction)

---

## File Structure

| Status | File | Responsibility |
|--------|------|----------------|
| New | `web/xedmail/src/lib/contacts.ts` | `extractContacts(messages)` — derives unique senders sorted by frequency |
| New | `web/xedmail/src/components/ui/smart-search-bar.tsx` | Full component: mirror div, input, ghost span, token parsing, key handling |
| Modified | `web/xedmail/src/app/page.tsx` | Swap in SmartSearchBar, add ⌘K hotkey, add query state |
| Modified | `web/xedmail/src/components/inbox/inbox-client.tsx` | Swap search input, replace `addEventListener` block with hotkeys-js, wire compose scope |
| Modified | `web/xedmail/package.json` | Add `hotkeys-js` |

---

### Task 1: Install hotkeys-js

**Files:**
- Modify: `web/xedmail/package.json`

- [ ] **Step 1: Install the package**

```bash
cd web/xedmail && npm install hotkeys-js
```

Expected: `hotkeys-js` appears in `package.json` dependencies.

- [ ] **Step 2: Verify types are available**

```bash
cd web/xedmail && npx tsc --noEmit 2>&1 | grep hotkeys
```

Expected: no output (types bundled). If you see `Cannot find module 'hotkeys-js'`, create `src/types/hotkeys-js.d.ts`:

```ts
declare module "hotkeys-js";
```

- [ ] **Step 3: Commit**

```bash
git add web/xedmail/package.json web/xedmail/package-lock.json
git commit -m "chore: add hotkeys-js"
```

---

### Task 2: Contact extraction utility

**Files:**
- Create: `web/xedmail/src/lib/contacts.ts`

- [ ] **Step 1: Create `contacts.ts`**

```ts
// web/xedmail/src/lib/contacts.ts
export type Contact = { name: string; address: string };

// Accept any object with `from: [string, string]` — compatible with both
// EmailDto (from mail-types) and the local Email interface in inbox-client.
export function extractContacts(messages: Array<{ from: [string, string] }>): Contact[] {
  const freq = new Map<string, { name: string; count: number }>();
  for (const m of messages) {
    const [name, addr] = m.from;
    if (!addr || addr === "unknown") continue;
    const entry = freq.get(addr);
    freq.set(addr, entry ? { name, count: entry.count + 1 } : { name, count: 1 });
  }
  return [...freq.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([address, { name }]) => ({ name, address }));
}
```

- [ ] **Step 2: Type-check**

```bash
cd web/xedmail && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web/xedmail/src/lib/contacts.ts
git commit -m "feat: add extractContacts utility"
```

---

### Task 3: Token parsing logic (inside SmartSearchBar)

**Files:**
- Create: `web/xedmail/src/components/ui/smart-search-bar.tsx` (skeleton + parseTokens only)

This task creates the file and gets the pure token-parsing logic right before adding the complex DOM/canvas code in Task 4.

- [ ] **Step 1: Create the file with types and `parseTokens`**

```tsx
// web/xedmail/src/components/ui/smart-search-bar.tsx
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
```

- [ ] **Step 2: Type-check**

```bash
cd web/xedmail && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web/xedmail/src/components/ui/smart-search-bar.tsx
git commit -m "feat: add SmartSearchBar skeleton with parseTokens"
```

---

### Task 4: Full SmartSearchBar component

**Files:**
- Modify: `web/xedmail/src/components/ui/smart-search-bar.tsx` (replace placeholder export with full component)

Replace the placeholder `SmartSearchBar` export with the full implementation below.

- [ ] **Step 1: Replace the placeholder with the full component**

Replace everything from `// Placeholder export...` to the end of the file with:

```tsx
// Size-specific layout constants
const SIZE_CONFIG = {
  lg: { paddingTop: 18, paddingRight: 24, paddingBottom: 18, paddingLeft: 44, fontSize: 16, iconLeft: 14, borderRadius: "1rem" },
  sm: { paddingTop: 8,  paddingRight: 16, paddingBottom: 8,  paddingLeft: 36, fontSize: 14, iconLeft: 10, borderRadius: "9999px" },
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

  const [lockedAddresses, setLockedAddresses] = useState<Set<string>>(() => new Set());
  const [ghostText, setGhostText] = useState("");
  const [ghostIndex, setGhostIndex] = useState(0);
  const [ghostLeft, setGhostLeft] = useState(0);
  const canvasCtx = useRef<CanvasRenderingContext2D | null>(null);
  const isMobile = useRef(false);

  const cfg = SIZE_CONFIG[size];

  // --- Initialise on mount ---
  useEffect(() => {
    // Detect mobile (no Tab key on touch keyboards)
    isMobile.current = window.matchMedia("(pointer: coarse)").matches;

    // Pre-populate lockedAddresses from initial value
    const initial = new Set<string>();
    const words = value.split(/\s+/);
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const addr = w.toLowerCase().startsWith("from:") ? w.slice(5) : (w === "from:" ? words[i + 1] : null);
      if (addr && addr.includes("@") && addr.split("@")[1]?.includes(".")) {
        initial.add(addr);
      }
    }
    setLockedAddresses(initial);

    // Init canvas for text measurement
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
    if (!last || last.type !== "from-keyword") return { ghostSuggestions: [], typedPartial: "" };
    const partial = last.text.toLowerCase().startsWith("from:")
      ? last.text.slice(last.text.indexOf(":") + 1).trimStart()
      : "";
    if (!partial) return { ghostSuggestions: [], typedPartial: "" };
    const matches = contacts.filter(
      (c) => c.address.toLowerCase().startsWith(partial) || c.name.toLowerCase().startsWith(partial),
    );
    return { ghostSuggestions: matches, typedPartial: partial };
  }, [value, lockedAddresses, contacts]);

  // Clamp ghostIndex when suggestions change
  useEffect(() => {
    setGhostIndex((i) => Math.min(i, Math.max(0, ghostSuggestions.length - 1)));
  }, [ghostSuggestions.length]);

  // Compute ghostText string
  useEffect(() => {
    if (isMobile.current || ghostSuggestions.length === 0) {
      setGhostText("");
      return;
    }
    const best = ghostSuggestions[ghostIndex];
    if (!best) { setGhostText(""); return; }
    setGhostText(best.address.slice(typedPartial.length));
  }, [ghostSuggestions, ghostIndex, typedPartial]);

  // Measure ghost span left position — run after every render where ghostText
  // is non-empty so scrollLeft is always fresh (spec: "not cached").
  useEffect(() => {
    if (!ghostText || !canvasCtx.current || !inputRef.current) return;
    const width = canvasCtx.current.measureText(value).width;
    // scrollLeft is intentionally read here, not cached — must stay in effect body
    setGhostLeft(cfg.paddingLeft + width - inputRef.current.scrollLeft);
  }); // no dep array — runs after every render

  // --- Tokens for mirror div ---
  const tokens = useMemo(() => parseTokens(value, lockedAddresses), [value, lockedAddresses]);

  // --- Key handler ---
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const ghostActive = ghostText.length > 0 && ghostSuggestions.length > 0;

    if (e.key === "Tab" && ghostActive) {
      e.preventDefault();
      e.nativeEvent.stopImmediatePropagation();
      // Accept: replace typed partial with full address
      const best = ghostSuggestions[ghostIndex];
      if (!best) return;
      const fullAddress = best.address;
      // Replace last "from: <partial>" with "from: <fullAddress>"
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
        setGhostIndex((i) => (i - 1 + ghostSuggestions.length) % ghostSuggestions.length);
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
      // if ghost inactive, let event bubble to inbox hotkeys
      return;
    }

    if (e.key === " " && typedPartial) {
      // Lock if typed partial looks like a complete email
      if (typedPartial.includes("@") && typedPartial.split("@")[1]?.includes(".")) {
        setLockedAddresses((prev) => new Set([...prev, typedPartial]));
      }
    }

    if (e.key === "Backspace") {
      // After deletion, check if any locked address is no longer in the resulting string
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

      {/* Mirror div — renders coloured token spans.
          Uses inline-block spans with white-space:pre so spacing exactly
          matches the <input> text rendering — no flex gap allowed here. */}
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
```

- [ ] **Step 2: Type-check**

```bash
cd web/xedmail && npx tsc --noEmit 2>&1 | head -30
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web/xedmail/src/components/ui/smart-search-bar.tsx
git commit -m "feat: implement SmartSearchBar with token highlighting and ghost text"
```

---

### Task 5: Homepage integration — swap search bar + add ⌘K

**Files:**
- Modify: `web/xedmail/src/app/page.tsx`

The current homepage has a plain `<input>` inside a `<div className="relative">` with separate icon and kbd hint divs. We replace all of that with `SmartSearchBar`.

- [ ] **Step 1: Update imports and add state/refs**

First, update the React import on line 5 of `page.tsx` to include `useRef` and `useMemo`:

```ts
import React, { useEffect, useMemo, useRef, useState } from "react";
```

Then add three new imports below the existing imports:

```ts
import hotkeys from "hotkeys-js";
import { SmartSearchBar } from "@/components/ui/smart-search-bar";
import { extractContacts } from "@/lib/contacts";
```

Inside the `Home` component, add below the existing `useJazzInboxState` destructure:

```ts
const contacts = useMemo(() => extractContacts(messages), [messages]);
const searchRef = useRef<HTMLInputElement>(null);
const [query, setQuery] = useState("");
```

- [ ] **Step 2: Register ⌘K hotkey**

Add this `useEffect` inside the component (after the existing `useEffect` blocks):

```ts
useEffect(() => {
  hotkeys("command+k, ctrl+k", (e) => {
    e.preventDefault();
    searchRef.current?.focus();
    searchRef.current?.select();
  });
  return () => hotkeys.unbind("command+k, ctrl+k");
}, []);
```

- [ ] **Step 3: Replace the search block in JSX**

Find the `<div className="relative">` that wraps the existing search icon + input + kbd hint (roughly lines 157–198 in current file). Replace the entire `<div className="relative">...</div>` block with:

```tsx
<SmartSearchBar
  size="lg"
  value={query}
  onChange={setQuery}
  onSubmit={(val) => {
    if (val) addRecentSearch(val);
    router.push(val ? `/inbox?query=${encodeURIComponent(val)}` : "/inbox");
  }}
  contacts={contacts}
  inputRef={searchRef}
  showKbdHint
  placeholder="Search your archive, contacts, or drafts..."
/>
```

- [ ] **Step 4: Type-check**

```bash
cd web/xedmail && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 5: Smoke test in browser**

Run `npm run dev`, open `http://localhost:3000`. Verify:
- Search bar is visible and slightly smaller than before
- Pressing `⌘K` (or `Ctrl+K`) focuses the search bar
- Typing `unread` highlights amber
- Typing `today` highlights green
- Typing `from: ` shows blue `from:` text; if contacts are cached, ghost text appears after typing partial

- [ ] **Step 6: Commit**

```bash
git add web/xedmail/src/app/page.tsx
git commit -m "feat: integrate SmartSearchBar on homepage with cmd+k focus"
```

---

### Task 6: Inbox integration — swap search bar + migrate keyboard shortcuts to hotkeys-js

**Files:**
- Modify: `web/xedmail/src/components/inbox/inbox-client.tsx`

This is the largest change. We replace the vanilla `addEventListener` keyboard block (lines 582–634) with `hotkeys-js` scoped shortcuts, and replace the inline search `<input>` with `SmartSearchBar`.

- [ ] **Step 1: Add imports**

At the top of `inbox-client.tsx`, add:

```ts
import hotkeys from "hotkeys-js";
import { SmartSearchBar } from "@/components/ui/smart-search-bar";
import { extractContacts } from "@/lib/contacts";
```

- [ ] **Step 2: Add `contacts` derived state**

Inside `InboxClient`, below the existing `useJazzInboxState` destructure, add:

```ts
const contacts = useMemo(() => extractContacts(emails), [emails]);
```

(`emails` is the prop passed to the component — it has `from: [string, string]` matching `EmailDto`.)

- [ ] **Step 3: Replace the `window.addEventListener` keyboard block**

Delete the entire `React.useEffect` block from `// ── Keyboard shortcuts ──` (line 582) through its closing `}, [filteredEmails.length, ...]` (line 634).

Replace it with:

```ts
// ── Keyboard shortcuts (hotkeys-js) ──
React.useEffect(() => {
  hotkeys.setScope("inbox");

  hotkeys("j, down", "inbox", (e) => {
    e.preventDefault();
    setFocusedIndex((i) => Math.min(i + 1, filteredEmails.length - 1));
  });
  hotkeys("k, up", "inbox", (e) => {
    e.preventDefault();
    setFocusedIndex((i) => Math.max(i - 1, 0));
  });
  hotkeys("enter", "inbox", (e) => {
    e.preventDefault();
    if (!isReaderOpen && focusedEmail) openEmail(focusedEmail, focusedIndex);
  });
  hotkeys("escape", "inbox", () => {
    if (isSnoozeOpen) setIsSnoozeOpen(false);
    else if (isReaderOpen) closeReader();
  });
  hotkeys("e", "inbox", (e) => {
    e.preventDefault();
    void handleArchive();
  });
  hotkeys("s", "inbox", (e) => {
    if (!e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      if (activeEmail) setIsSnoozeOpen((o) => !o);
    }
  });
  hotkeys("r", "inbox", (e) => {
    if (!e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      openReply();
    }
  });

  return () => {
    hotkeys.unbind("j, down", "inbox");
    hotkeys.unbind("k, up", "inbox");
    hotkeys.unbind("enter", "inbox");
    hotkeys.unbind("escape", "inbox");
    hotkeys.unbind("e", "inbox");
    hotkeys.unbind("s", "inbox");
    hotkeys.unbind("r", "inbox");
    hotkeys.setScope("all");
  };
}, [filteredEmails.length, focusedEmail, focusedIndex, isReaderOpen, isSnoozeOpen, activeEmail, handleArchive, openReply, closeReader]);
```

- [ ] **Step 4: Wire compose modal scope**

Find where `isComposeOpen` is set to `true` (line ~519, inside `openReply`). Immediately after `setIsComposeOpen(true)`, add:

```ts
hotkeys("escape", "compose", () => setIsComposeOpen(false));
hotkeys.setScope("compose");
```

Find where `setIsComposeOpen(false)` is called on compose close (lines ~543 and ~572 inside `handleSend`/`handleScheduleSend`, and line ~1103 in the JSX close button). In all three places, after `setIsComposeOpen(false)`, add:

```ts
hotkeys.unbind("escape", "compose");
hotkeys.setScope("inbox");
```

The JSX close button (line ~1103) looks like:
```tsx
onClick={() => setIsComposeOpen(false)}
```
Change it to:
```tsx
onClick={() => {
  setIsComposeOpen(false);
  hotkeys.unbind("escape", "compose");
  hotkeys.setScope("inbox");
}}
```

- [ ] **Step 5: Replace the inline search `<input>` with SmartSearchBar**

Find the `<div className="relative hidden lg:block">` search block (lines 674–703). Replace the entire block with:

```tsx
<div className="hidden lg:block">
  <SmartSearchBar
    size="sm"
    value={localQuery}
    onChange={setLocalQuery}
    onSubmit={(val) => {
      if (val) addRecentSearch(val);
      router.push(val ? `/inbox?query=${encodeURIComponent(val)}` : "/inbox");
    }}
    contacts={contacts}
    placeholder="Search..."
  />
</div>
```

- [ ] **Step 6: Type-check**

```bash
cd web/xedmail && npx tsc --noEmit 2>&1 | head -30
```

Expected: no errors.

- [ ] **Step 7: Smoke test in browser**

Run `npm run dev`, open `http://localhost:3000/inbox`. Verify:
- `j` / `k` navigate through emails (only when search bar is not focused)
- `e` archives the focused email
- `s` opens snooze menu
- `r` opens compose/reply
- `Escape` closes reader or snooze menu
- `Enter` opens focused email
- Clicking the search bar then pressing `j` does NOT navigate (hotkeys-js filter blocks it)
- Opening compose suppresses inbox shortcuts; Escape closes compose, then inbox shortcuts resume

- [ ] **Step 8: Commit**

```bash
git add web/xedmail/src/components/inbox/inbox-client.tsx
git commit -m "feat: integrate SmartSearchBar in inbox and migrate shortcuts to hotkeys-js"
```

---

### Task 7: Final type-check and lint

**Files:** none (verification only)

- [ ] **Step 1: Full type-check**

```bash
cd web/xedmail && npx tsc --noEmit 2>&1
```

Expected: no output (zero errors).

- [ ] **Step 2: Lint**

```bash
cd web/xedmail && npm run lint 2>&1 | head -30
```

Expected: no errors. Fix any Biome warnings before committing.

- [ ] **Step 3: Commit lint fixes if any**

```bash
git add -p  # stage only lint fix changes
git commit -m "fix: lint warnings from SmartSearchBar integration"
```

---

### Testing checklist (manual, no automated tests needed for this UI feature)

Run the dev server (`npm run dev`) and verify each behaviour:

**Homepage:**
- [ ] `⌘K` / `Ctrl+K` focuses and selects the search bar from anywhere on the page
- [ ] Typing `unread` → amber highlight with background
- [ ] Typing `today` → green highlight with background
- [ ] Typing `from: ` → `from:` turns blue, then typing a partial address shows faded ghost text if contacts are cached
- [ ] Pressing `Tab` with ghost text active → accepts the address, token gains blue background
- [ ] Pressing `↑` / `↓` with ghost active → cycles through contact matches
- [ ] Pressing `Esc` with ghost active → dismisses ghost (no navigation)
- [ ] Pressing `Enter` → navigates to inbox with query, saves to recent searches
- [ ] `⌘K` hint badge is visible on the right side of the bar

**Inbox:**
- [ ] `j` / `↓` → next email (when search not focused)
- [ ] `k` / `↑` → prev email (when search not focused)
- [ ] `e` → archive focused email
- [ ] `s` → snooze menu opens/closes
- [ ] `r` → reply compose opens
- [ ] `Enter` → opens focused email in reader
- [ ] `Escape` → closes reader (or snooze menu if open)
- [ ] Clicking search bar then pressing `j` → does NOT navigate (correct: hotkeys-js blocks it on inputs)
- [ ] Opening compose via `r` → `j/k/e/s/r` no longer fire; `Escape` closes compose
- [ ] After closing compose → `j/k/e/s/r` work again
- [ ] Token highlighting works same as homepage in the inbox search bar
