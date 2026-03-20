# Smart Search Bar Design

## Goal

Replace the plain text search inputs on the homepage and in the inbox with a `SmartSearchBar` component that highlights recognised query tokens inline, provides ghost-text contact completion when `from:` is typed, focuses via `⌘K / Ctrl+K`, and migrates all keyboard shortcuts to `hotkeys-js`.

## Architecture

A single shared React component (`SmartSearchBar`) owns its own `<div style="position: relative">` wrapper (including the search icon). Inside that wrapper:

1. A **mirror div** (absolute, `inset: 0`, `pointer-events: none`, `z-index: 1`) renders coloured token spans matching the input's font and padding.
2. A real **`<input>`** (relative, `z-index: 2`, `color: transparent`, `caret-color: #FFB77B`, `background: transparent`) receives all keystrokes.
3. A **ghost span** (absolute, `z-index: 3`, `pointer-events: none`) shows the faded contact completion, positioned using canvas text measurement.

The search icon is rendered inside `SmartSearchBar`'s own wrapper at a fixed `left` offset so icon width is always known.

## Component

**File:** `src/components/ui/smart-search-bar.tsx`

```ts
type Contact = { name: string; address: string };

type SmartSearchBarProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  contacts: Contact[];
  placeholder?: string;
  size: "lg" | "sm";
  showKbdHint?: boolean; // renders the ⌘K badge on the right; only used by the lg homepage variant
  inputRef?: React.RefObject<HTMLInputElement | null>;
};

// Size-specific constants (used by input, mirror div, and ghost span identically):
// lg: paddingTop 18, paddingRight 24, paddingBottom 18, paddingLeft 44, fontSize 16, iconLeft 14
// sm: paddingTop 8,  paddingRight 16, paddingBottom 8,  paddingLeft 36, fontSize 14, iconLeft 10
```

### Internal state

| State | Type | Purpose |
|-------|------|---------|
| `lockedAddresses` | `Set<string>` | Addresses accepted via Tab/Space. Initialised from `value` on mount (see Initialisation). |
| `ghostText` | `string` | Untyped remainder of the best contact match. |
| `ghostIndex` | `number` | Index into `matchingContacts` for ↑↓ cycling. |
| `isMobile` | `boolean` | `window.matchMedia("(pointer: coarse)").matches`, read once on mount. Ghost span hidden when true. |
| `canvasCtx` | `ref` | `useRef<CanvasRenderingContext2D \| null>(null)` — canvas context reused across renders, never re-created. |

### Initialisation of `lockedAddresses`

On mount only (`useEffect` with `[]` dependency), parse the initial `value` prop and pre-populate `lockedAddresses` with any address that is syntactically complete — meaning it contains exactly one `@` with at least one `.` after the `@`. This means a `from: alice@example.com` token that arrives via URL on initial render is treated as locked immediately, avoiding a flash of `from-keyword` styling. No subsequent re-initialisation is needed — `lockedAddresses` evolves through Tab/Space accepts and Backspace evictions after mount.

### Token parsing

`parseTokens(value: string, lockedAddresses: Set<string>): Token[]`

Left-to-right scan of space-separated segments:

| Type | Detection | Text colour | Background |
|------|-----------|-------------|------------|
| `from-locked` | segment starts with `from:` and address is in `lockedAddresses` | `#93c5fd` | `rgba(96,165,250,0.1)` |
| `from-keyword` | segment starts with `from:` and address is NOT in `lockedAddresses` | `#93c5fd` | none |
| `status` | case-insensitive exact match `unread` or `read` | `#fbbf24` | `rgba(251,191,36,0.1)` |
| `date` | case-insensitive exact `today`, `yesterday`, `/^last \d+ days$/i` | `#86efac` | `rgba(134,239,172,0.1)` |
| `keyword` | everything else | `rgba(229,226,225,0.5)` | none |

`status` and `date` tokens lock in with their background immediately — no Tab needed.

### Ghost text

Ghost text activates when the last token is `from-keyword` and at least one character follows `from:`.

`matchingContacts` = contacts where `address.toLowerCase().startsWith(partial)` or `name.toLowerCase().startsWith(partial)`.

`ghostText` = `matchingContacts[ghostIndex].address.slice(partial.length)`.

Ghost span is not rendered when `isMobile` is true or `matchingContacts` is empty.

### Ghost span positioning

```ts
function measureWidth(ctx: CanvasRenderingContext2D, text: string): number {
  return ctx.measureText(text).width;
}
```

On first render after mount, initialise the canvas context once:
```ts
const canvas = document.createElement("canvas");
canvasCtx.current = canvas.getContext("2d")!;
// Set font including weight to match input:
canvasCtx.current.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
// Read fontWeight from getComputedStyle(inputRef.current).fontWeight
```

Ghost span `left` = `paddingLeft + measureWidth(ctx, value) - inputRef.current.scrollLeft`.

Subtracting `inputRef.current.scrollLeft` keeps the ghost span aligned with the cursor even when the typed text overflows the input width and the browser has scrolled the text left. Read `scrollLeft` on every render where ghost text is non-empty (not cached).

`fontFamily` = `"Inter, sans-serif"`. `fontWeight` = read from `getComputedStyle(inputRef.current).fontWeight` once on mount.

### Key handling (`onKeyDown` on the `<input>`)

**When ghost text is active, these keys must call both `e.preventDefault()` and `e.nativeEvent.stopImmediatePropagation()`** — `stopImmediatePropagation()` is required (not just `stopPropagation()`) because `hotkeys-js` attaches its listener directly to `window`, outside React's synthetic event system.

| Key | Ghost active | Ghost inactive |
|-----|-------------|----------------|
| **Tab** | Accept: replace partial with full address, add to `lockedAddresses`, clear ghost. | Let browser handle (focus next element). |
| **↑** | Decrement `ghostIndex` (wrap). Prevent + stopImmediatePropagation. | Bubble (inbox handler moves prev email). |
| **↓** | Increment `ghostIndex` (wrap). Prevent + stopImmediatePropagation. | Bubble (inbox handler moves next email). |
| **Escape** | Clear ghost. Prevent + stopImmediatePropagation. | Bubble (inbox handler closes reader). |
| **Space** | If partial passes email heuristic (contains `@` and at least one `.` after it): add to `lockedAddresses`, lock token. | Normal space. |
| **Backspace** | If `value.slice(0, -1)` no longer contains the full locked address: remove that address from `lockedAddresses`, re-activate ghost. | Normal backspace. |

The Backspace detection compares the value *after* deletion against `lockedAddresses` entries — if the resulting string no longer includes `address` as a substring, the address is evicted from the set. This avoids the ambiguity of inspecting which character was deleted.

### Contact extraction

**File:** `src/lib/contacts.ts`

```ts
import type { EmailDto } from "@/lib/mail-types";

export type Contact = { name: string; address: string };

export function extractContacts(messages: EmailDto[]): Contact[] {
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

On the homepage, `messages` is populated from the Jazz local cache (no network required). On first load before any sync, `messages` will be empty and `contacts` will be `[]` — ghost text will simply not appear until Jazz hydrates. This is acceptable behaviour.

## Keyboard shortcuts via hotkeys-js

**Package:** `hotkeys-js`. Import as `import hotkeys from "hotkeys-js"` in every file that uses it. If the installed version lacks bundled types and TypeScript reports a module error, add a local declaration shim: `// src/types/hotkeys-js.d.ts` containing `declare module "hotkeys-js"`.

### Homepage (`page.tsx`)

```ts
import hotkeys from "hotkeys-js";

const searchRef = useRef<HTMLInputElement>(null);

useEffect(() => {
  hotkeys("command+k, ctrl+k", (e) => {
    e.preventDefault();
    searchRef.current?.focus();
    searchRef.current?.select();
  });
  return () => hotkeys.unbind("command+k, ctrl+k");
}, []);
```

### Inbox (`inbox-client.tsx`)

Remove the entire `window.addEventListener("keydown", handler)` block. Replace with:

```ts
import hotkeys from "hotkeys-js";

useEffect(() => {
  hotkeys.setScope("inbox");

  hotkeys("j, down",  "inbox", (e) => { e.preventDefault(); /* next email */ });
  hotkeys("k, up",    "inbox", (e) => { e.preventDefault(); /* prev email */ });
  hotkeys("e",        "inbox", () => { /* archive */ });
  hotkeys("s",        "inbox", () => { /* snooze */ });
  hotkeys("r",        "inbox", () => { /* reply */ });
  hotkeys("enter",    "inbox", (e) => { e.preventDefault(); /* open reader */ });
  hotkeys("escape",   "inbox", () => { /* close reader/snooze */ });

  return () => {
    hotkeys.unbind("j, down",  "inbox");
    hotkeys.unbind("k, up",    "inbox");
    hotkeys.unbind("e",        "inbox");
    hotkeys.unbind("s",        "inbox");
    hotkeys.unbind("r",        "inbox");
    hotkeys.unbind("enter",    "inbox");
    hotkeys.unbind("escape",   "inbox");
    // Do NOT call hotkeys.deleteScope — it removes shared global state.
    // Restore to a neutral scope on unmount:
    hotkeys.setScope("all");
  };
}, [/* stable callbacks */]);
```

`hotkeys-js` built-in filter already skips all shortcuts when focus is on an `<input>`, `<textarea>`, or `<select>` — no manual tag-name check needed.

### Compose modal scope

When compose modal opens: `hotkeys.setScope("compose")` — no shortcuts are registered under `"compose"`, so all inbox shortcuts are silently suppressed.

Register Escape under `"compose"` to close the modal:
```ts
hotkeys("escape", "compose", () => { /* close compose modal */ });
```
Unbind this when compose closes: `hotkeys.unbind("escape", "compose")`.

When compose modal closes: `hotkeys.setScope("inbox")`.

`"all"` is not used as an active scope. In `hotkeys-js`, shortcuts registered under `"all"` fire in every scope, so setting the active scope to `"all"` does not suppress inbox shortcuts.

### Note on `stopImmediatePropagation`

`hotkeys-js` built-in filter already skips all shortcuts when focus is on an `<input>`. This means when `SmartSearchBar`'s input is focused, `hotkeys-js` will not fire inbox `↑/↓/Escape` handlers regardless. The `e.nativeEvent.stopImmediatePropagation()` calls in the ghost key handlers are a belt-and-suspenders safety measure for any other `window`-level `keydown` listener that may exist, not specifically for `hotkeys-js`. They are harmless and should be kept.

## Integration

### Homepage (`src/app/page.tsx`)

```ts
import { extractContacts } from "@/lib/contacts";
import { SmartSearchBar } from "@/components/ui/smart-search-bar";

const { messages, ... } = useJazzInboxState();
const contacts = useMemo(() => extractContacts(messages), [messages]);
const searchRef = useRef<HTMLInputElement>(null);
const [query, setQuery] = useState("");
```

Replace the existing `<div className="relative">` search block (input + icon wrapper + kbd hint) with:
```tsx
<SmartSearchBar
  size="lg"
  value={query}
  onChange={setQuery}
  onSubmit={(val) => { if (val) addRecentSearch(val); router.push(val ? `/inbox?query=${encodeURIComponent(val)}` : "/inbox"); }}
  contacts={contacts}
  inputRef={searchRef}
  showKbdHint
  placeholder="Search your archive, contacts, or drafts..."
/>
```

`SmartSearchBar` renders its own search icon and the `⌘K` hint badge internally — remove the existing `<div className="absolute inset-y-0 left-6 ...">` and `<div className="absolute inset-y-0 right-6 ...">` wrappers.

### Inbox (`src/components/inbox/inbox-client.tsx`)

```ts
import { extractContacts } from "@/lib/contacts";
import { SmartSearchBar } from "@/components/ui/smart-search-bar";

const contacts = useMemo(() => extractContacts(emails), [emails]);
```

Replace existing inbox search `<input>` with:
```tsx
<SmartSearchBar
  size="sm"
  value={localQuery}
  onChange={setLocalQuery}
  onSubmit={(val) => { if (val) addRecentSearch(val); router.push(val ? `/inbox?query=${encodeURIComponent(val)}` : "/inbox"); }}
  contacts={contacts}
  placeholder="Search..."
/>
```

## Files changed

| Status | File |
|--------|------|
| New | `src/components/ui/smart-search-bar.tsx` |
| New | `src/lib/contacts.ts` |
| Modified | `src/app/page.tsx` |
| Modified | `src/components/inbox/inbox-client.tsx` |
| Modified | `package.json` (add `hotkeys-js`) |

## Out of scope

- Server-side contact index or dedicated contacts table.
- Saving contacts to Jazz state.
- Autocomplete beyond `from:`, `read/unread`, and date keywords.
- Animated token transitions.
