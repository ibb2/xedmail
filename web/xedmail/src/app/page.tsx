"use client";

import { useSession, signOut } from "@/lib/auth-client";
import hotkeys from "hotkeys-js";
import { useRouter } from "next/navigation";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SmartSearchBar } from "@/components/ui/smart-search-bar";
import { extractContacts } from "@/lib/contacts";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/lib/dexie";
import { useAllInboxEmails } from "@/hooks/use-inbox";

const QUICK_FILTERS = [
  { icon: "attach_file", label: "Has Attachment" },
  { icon: "star", label: "Starred" },
  { icon: "schedule", label: "Last 7 Days" },
  { icon: "person", label: "From Team" },
];

const CONTACT_PALETTES = [
  { bg: "#54463d", color: "#c8b5a8" },
  { bg: "#a28d7d", color: "#35271b" },
  { bg: "rgba(200,128,63,0.12)", color: "#ffb77b" },
  { bg: "#3d4a54", color: "#a8c0c8" },
  { bg: "#4a3d54", color: "#c8a8d8" },
] as const;

function getInitials(name: string, address: string): string {
  if (name) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2)
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    if (parts[0]?.length >= 1) return parts[0][0].toUpperCase();
  }
  return address[0]?.toUpperCase() ?? "?";
}

export default function Home() {
  const router = useRouter();
  const messages = useAllInboxEmails();
  const recentSearches = useLiveQuery(
    () => db.recentSearches.orderBy("searchedAt").reverse().limit(10).toArray(),
    [],
    [],
  ) ?? [];
  const addRecentSearch = useCallback(async (q: string) => {
    await db.recentSearches.add({ query: q, searchedAt: Date.now() });
  }, []);
  const contacts = useMemo(
    () => extractContacts(messages.map((m) => ({ from: [m.fromName, m.fromAddress] as [string, string] }))),
    [messages],
  );
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [profileOpen, setProfileOpen] = useState(false);
  const { data: session } = useSession();

  const firstName = session?.user?.name?.split(" ")[0] ?? "there";

  const hour = new Date().getHours();
  const greeting =
    hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  const beginOauthFlow = async () => {
    const response = await fetch("/api/mail/oauth/start", {});
    if (!response.ok) {
      console.error("Failed to start OAuth flow");
      return;
    }
    const data = await response.json();
    router.push(data["authUrl"]);
  };

  useEffect(() => {
    hotkeys("command+k, ctrl+k", (e) => {
      e.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    });
    return () => hotkeys.unbind("command+k, ctrl+k");
  }, []);

  const formatTimeAgo = (ts: number) => {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return days === 1 ? "Yesterday" : `${days}d ago`;
  };

  return (
    <div
      className="min-h-screen"
      style={{
        background: "#131313",
        fontFamily: "'Inter', sans-serif",
        color: "#E5E2E1",
      }}
    >
      {/* Top Navigation Bar */}
      <header
        className="fixed top-0 left-0 w-full z-50 flex justify-between items-center px-6 py-3"
        style={{
          background: "rgba(19,19,19,0.8)",
          backdropFilter: "blur(20px)",
        }}
      >
        <div className="flex items-center justify-center gap-8">
          {/* <span
            className="text-xl font-medium tracking-tight"
            style={{ color: "#E5E2E1", fontFamily: "'Newsreader', serif" }}
          >
            June
          </span> */}
        </div>
        {/* Utility Area */}
        <div
          className="flex items-center gap-1"
          style={{
            background: "#1C1B1B",
            borderRadius: "1rem",
            padding: "6px",
          }}
        >
          <button
            type="button"
            className="flex items-center p-2 transition-colors"
            style={{ color: "#D8C3B4", borderRadius: "0.5rem" }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "#FFB77B")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "#D8C3B4")}
          >
            <span
              className="material-symbols-outlined"
              style={{ fontSize: 20 }}
            >
              palette
            </span>
          </button>
          <button
            type="button"
            className="flex items-center p-2 transition-colors"
            style={{ color: "#D8C3B4", borderRadius: "0.5rem" }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "#FFB77B")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "#D8C3B4")}
          >
            <span
              className="material-symbols-outlined"
              style={{ fontSize: 20 }}
            >
              settings
            </span>
          </button>
          <div
            style={{
              width: 1,
              height: 16,
              background: "rgba(82,68,57,0.5)",
              margin: "0 4px",
            }}
          />
          <div style={{ position: "relative" }}>
            <button
              type="button"
              className="flex items-center gap-2 transition-all"
              style={{ padding: "4px 8px 4px 4px", borderRadius: "0.75rem" }}
              onClick={() => setProfileOpen((o) => !o)}
            >
              <div
                className="flex items-center justify-center overflow-hidden"
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: "9999px",
                  background: "rgba(200,128,63,0.2)",
                  border: "1px solid rgba(255,183,123,0.2)",
                  fontSize: 11,
                  fontWeight: 700,
                  color: "#FFB77B",
                  fontFamily: "'Inter', sans-serif",
                }}
              >
                {(session?.user?.name?.[0] ?? "U").toUpperCase()}
              </div>
              <span
                className="material-symbols-outlined"
                style={{ fontSize: 14, color: "#D8C3B4" }}
              >
                expand_more
              </span>
            </button>
            {profileOpen && (
              <>
                <div
                  style={{ position: "fixed", inset: 0, zIndex: 40 }}
                  onClick={() => setProfileOpen(false)}
                />
                <div
                  style={{
                    position: "absolute",
                    top: "calc(100% + 8px)",
                    right: 0,
                    zIndex: 50,
                    background: "#1C1B1B",
                    border: "1px solid rgba(82,68,57,0.4)",
                    borderRadius: "0.75rem",
                    minWidth: 200,
                    padding: "4px",
                    boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
                  }}
                >
                  <div
                    style={{
                      padding: "8px 12px 6px",
                      borderBottom: "1px solid rgba(82,68,57,0.3)",
                      marginBottom: 4,
                    }}
                  >
                    <div
                      style={{
                        fontSize: 13,
                        fontWeight: 600,
                        color: "#E5E2E1",
                      }}
                    >
                      {session?.user?.name}
                    </div>
                    <div
                      style={{ fontSize: 11, color: "rgba(216,195,180,0.5)" }}
                    >
                      {session?.user?.email}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setProfileOpen(false);
                      beginOauthFlow();
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      width: "100%",
                      padding: "8px 12px",
                      borderRadius: "0.5rem",
                      background: "transparent",
                      border: "none",
                      color: "#E5E2E1",
                      fontSize: 13,
                      cursor: "pointer",
                      fontFamily: "'Inter', sans-serif",
                      textAlign: "left",
                    }}
                    onMouseEnter={(e) =>
                      (e.currentTarget.style.background =
                        "rgba(255,183,123,0.08)")
                    }
                    onMouseLeave={(e) =>
                      (e.currentTarget.style.background = "transparent")
                    }
                  >
                    <span
                      className="material-symbols-outlined"
                      style={{ fontSize: 16, color: "#FFB77B" }}
                    >
                      inbox
                    </span>
                    Connect inbox
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      setProfileOpen(false);
                      await signOut();
                      router.push("/login");
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      width: "100%",
                      padding: "8px 12px",
                      borderRadius: "0.5rem",
                      background: "transparent",
                      border: "none",
                      color: "rgba(216,195,180,0.6)",
                      fontSize: 13,
                      cursor: "pointer",
                      fontFamily: "'Inter', sans-serif",
                      textAlign: "left",
                    }}
                    onMouseEnter={(e) =>
                      (e.currentTarget.style.background =
                        "rgba(255,183,123,0.08)")
                    }
                    onMouseLeave={(e) =>
                      (e.currentTarget.style.background = "transparent")
                    }
                  >
                    <span
                      className="material-symbols-outlined"
                      style={{ fontSize: 16 }}
                    >
                      logout
                    </span>
                    Sign out
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main
        className="mx-auto max-w-4xl px-6 flex flex-col items-center"
        style={{ paddingTop: 96, paddingBottom: 96 }}
      >
        {/* Workspace status */}
        <div className="w-full mb-8">
          <p
            className="mb-3"
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 10,
              letterSpacing: "0.15em",
              textTransform: "uppercase",
              color: "rgba(255,183,123,0.6)",
            }}
          >
            {/* Workspace Status: Active */}
            June
          </p>
          <h1
            style={{
              fontFamily: "'Newsreader', serif",
              fontSize: "clamp(2.5rem, 6vw, 3.75rem)",
              lineHeight: 1.15,
              color: "#E5E2E1",
            }}
          >
            {greeting},{" "}
            <em style={{ fontStyle: "italic", fontWeight: 400 }}>
              {firstName}
            </em>
            .
          </h1>
        </div>

        {/* Search + Filters */}
        <div
          className="w-full"
          style={{ display: "flex", flexDirection: "column", gap: 20 }}
        >
          {/* Search bar */}
          <SmartSearchBar
            size="lg"
            value={query}
            onChange={setQuery}
            onSubmit={(val) => {
              if (val) addRecentSearch(val);
              router.push(
                val ? `/inbox?query=${encodeURIComponent(val)}` : "/inbox",
              );
            }}
            contacts={contacts}
            inputRef={searchRef}
            showKbdHint
            placeholder="Search your archive, contacts, or drafts..."
          />

          {/* Quick filters */}
          <div className="flex flex-wrap gap-3 items-center justify-center">
            {QUICK_FILTERS.map(({ icon, label }) => (
              <button
                key={label}
                type="button"
                className="flex items-center gap-2 transition-all"
                style={{
                  padding: "7px 14px",
                  borderRadius: "0.75rem",
                  background: "#1C1B1B",
                  border: "1px solid rgba(82,68,57,0.3)",
                  color: "#D8C3B4",
                  fontSize: 10,
                  fontWeight: 500,
                }}
                onClick={() =>
                  router.push(
                    `/inbox?query=${encodeURIComponent(label.toLowerCase())}`,
                  )
                }
                onMouseEnter={(e) =>
                  (e.currentTarget.style.background = "#353535")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.background = "#1C1B1B")
                }
              >
                <span
                  className="material-symbols-outlined"
                  style={{ fontSize: 13 }}
                >
                  {icon}
                </span>
                {label}
              </button>
            ))}
          </div>

          {/* Grid: Recent Searches + Suggested Contacts */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-20">
            {/* Recent Searches */}
            <div className="flex flex-col gap-4">
              <h3
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 10,
                  letterSpacing: "0.15em",
                  textTransform: "uppercase",
                  color: "rgba(216,195,180,0.6)",
                  padding: "0 8px",
                }}
              >
                Recent Searches
              </h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {recentSearches.length === 0 && (
                  <p
                    style={{
                      padding: "16px",
                      color: "rgba(216,195,180,0.4)",
                      fontSize: 14,
                    }}
                  >
                    No recent searches
                  </p>
                )}
                {recentSearches.map((s) => (
                  <a
                    key={String(s.id)}
                    href="#"
                    className="flex items-center justify-between group transition-all"
                    style={{ padding: "16px", borderRadius: "1rem" }}
                    onClick={(e) => {
                      e.preventDefault();
                      router.push(
                        `/inbox?query=${encodeURIComponent(s.query)}`,
                      );
                    }}
                    onMouseEnter={(e) =>
                      (e.currentTarget.style.background = "#1C1B1B")
                    }
                    onMouseLeave={(e) =>
                      (e.currentTarget.style.background = "transparent")
                    }
                  >
                    <div className="flex items-center gap-4">
                      <span
                        className="material-symbols-outlined transition-colors"
                        style={{ color: "rgba(216,195,180,0.4)", fontSize: 20 }}
                      >
                        history
                      </span>
                      <span
                        style={{ color: "rgba(229,226,225,0.8)", fontSize: 14 }}
                      >
                        {s.query}
                      </span>
                    </div>
                    <span
                      style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 10,
                        color: "rgba(216,195,180,0.4)",
                      }}
                    >
                      {formatTimeAgo(s.searchedAt)}
                    </span>
                  </a>
                ))}
              </div>
            </div>

            {/* Suggested Contacts */}
            <div className="flex flex-col gap-4">
              <h3
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 10,
                  letterSpacing: "0.15em",
                  textTransform: "uppercase",
                  color: "rgba(216,195,180,0.6)",
                  padding: "0 8px",
                }}
              >
                Suggested Contacts
              </h3>
              <div className="flex flex-wrap gap-3">
                {contacts.length === 0 && (
                  <p
                    style={{
                      padding: "16px",
                      color: "rgba(216,195,180,0.4)",
                      fontSize: 14,
                    }}
                  >
                    No contacts yet
                  </p>
                )}
                {contacts.slice(0, 6).map((c, idx) => {
                  const palette =
                    CONTACT_PALETTES[idx % CONTACT_PALETTES.length];
                  const initials = getInitials(c.name, c.address);
                  const displayName = c.name || c.address.split("@")[0];
                  return (
                    <button
                      key={c.address}
                      type="button"
                      className="flex flex-1 items-center gap-3 transition-all"
                      style={{
                        padding: "8px 16px 8px 8px",
                        borderRadius: "1rem",
                        background: "#0E0E0E",
                        border: "1px solid rgba(82,68,57,0.3)",
                      }}
                      onClick={() => {
                        const q = `from: ${c.address}`;
                        addRecentSearch(q);
                        router.push(`/inbox?query=${encodeURIComponent(q)}`);
                      }}
                      onMouseEnter={(e) =>
                        (e.currentTarget.style.background = "#1C1B1B")
                      }
                      onMouseLeave={(e) =>
                        (e.currentTarget.style.background = "#0E0E0E")
                      }
                    >
                      <div
                        className="flex items-center justify-center"
                        style={{
                          width: 32,
                          height: 32,
                          borderRadius: "9999px",
                          background: palette.bg,
                          color: palette.color,
                          fontSize: 11,
                          fontWeight: 700,
                        }}
                      >
                        {initials}
                      </div>
                      <div className="text-left">
                        <p
                          style={{
                            fontSize: 12,
                            fontWeight: 500,
                            color: "#E5E2E1",
                          }}
                        >
                          {displayName}
                        </p>
                        <p
                          style={{
                            fontSize: 10,
                            color: "rgba(216,195,180,0.6)",
                          }}
                        >
                          {c.address}
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* FAB Compose */}
      <button
        type="button"
        className="fixed flex items-center justify-center transition-all hover:scale-105 active:scale-95"
        style={{
          bottom: 32,
          right: 32,
          width: 56,
          height: 56,
          borderRadius: "1rem",
          zIndex: 50,
          background: "linear-gradient(135deg, #FFB77B, #C8803F)",
          boxShadow: "0 10px 25px -5px rgba(255,183,123,0.2)",
          color: "#4D2700",
        }}
        title="Compose"
        onClick={beginOauthFlow}
      >
        <span
          className="material-symbols-outlined"
          style={{ fontSize: 22, fontVariationSettings: "'FILL' 1" }}
        >
          edit
        </span>
      </button>
    </div>
  );
}
