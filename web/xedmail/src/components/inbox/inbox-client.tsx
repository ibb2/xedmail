// src/components/inbox/inbox-client.tsx
"use client";

import React, { useMemo, useState } from "react";
import DOMPurify from "dompurify";
import { useAuth, useUser } from "@clerk/nextjs";
import { useJazzInboxState } from "@/providers/jazz-provider";
import { useRouter } from "next/navigation";

interface Email {
  id: string;
  uid: string;
  mailboxAddress: string;
  subject: string;
  from: [string, string];
  to: string;
  body?: string;
  date: string;
  isRead: boolean;
  isNew?: boolean;
  snoozedUntil?: string;
  isArchived?: boolean;
}

function getEmailKey(email: Pick<Email, "mailboxAddress" | "uid">) {
  return `${email.mailboxAddress}:${email.uid}`;
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr);
  const now = new Date();
  if (d.toDateString() === now.toDateString())
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function formatFullDate(dateStr: string) {
  const d = new Date(dateStr);
  return (
    d.toLocaleDateString([], { day: "numeric", month: "long", year: "numeric" }) +
    " at " +
    d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  );
}

function getInitials(name: string) {
  return name
    .split(" ")
    .map((w) => w[0]?.toUpperCase() ?? "")
    .slice(0, 2)
    .join("");
}

// ─── Full-Screen Email Reader ──────────────────────────────────────────────────

function EmailReader({
  email,
  body,
  onClose,
  onToggleRead,
  emails,
  emailIndex,
  onNavigate,
}: {
  email: Email;
  body: string;
  onClose: () => void;
  onToggleRead: (email: Email) => Promise<void>;
  emails: Email[];
  emailIndex: number;
  onNavigate: (email: Email, index: number) => Promise<void>;
}) {
  const clean = body ? DOMPurify.sanitize(body) : "";
  const emailDate = new Date(email.date);
  const dateStr =
    emailDate.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }).toUpperCase() +
    " · " +
    emailDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) +
    " PST";

  const { user } = useUser();
  const router = useRouter();

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col overflow-hidden"
      style={{ background: "#131313", fontFamily: "'Inter', sans-serif" }}
    >
      {/* Top nav */}
      <nav
        className="fixed top-0 left-0 w-full z-50 flex justify-between items-center px-6 py-3"
        style={{ background: "rgba(19,19,19,0.8)", backdropFilter: "blur(20px)" }}
      >
        <div className="flex items-center gap-8">
          <span
            style={{ fontFamily: "'Newsreader', serif", fontSize: 20, fontWeight: 500, letterSpacing: "-0.02em", color: "#E5E2E1" }}
          >
            June
          </span>
        </div>
       <div className="flex items-center gap-1" style={{ background: "#1C1B1B", borderRadius: "1rem", padding: "6px" }}>
          <button
            type="button"
            className="p-2 transition-colors"
            style={{ color: "#D8C3B4", borderRadius: "0.5rem" }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "#FFB77B")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "#D8C3B4")}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 20 }}>palette</span>
          </button>
          <button
            type="button"
            onClick={() => router.push("/settings")}
            className="p-2 transition-colors"
            style={{ color: "#D8C3B4", borderRadius: "0.5rem" }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "#FFB77B")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "#D8C3B4")}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 20 }}>settings</span>
          </button>
          <div style={{ width: 1, height: 16, background: "rgba(82,68,57,0.5)", margin: "0 4px" }} />
          <button
            type="button"
            className="flex items-center gap-2 transition-all"
            style={{ padding: "4px 8px 4px 4px", borderRadius: "0.75rem" }}
          >
            <div
              className="flex items-center justify-center overflow-hidden"
              style={{
                width: 28, height: 28, borderRadius: "9999px",
                background: "rgba(200,128,63,0.2)",
                border: "1px solid rgba(255,183,123,0.2)",
                fontSize: 11, fontWeight: 700, color: "#FFB77B",
                fontFamily: "'Inter', sans-serif",
              }}
            >
              {(user?.firstName?.[0] ?? "U").toUpperCase()}
            </div>
            <span className="material-symbols-outlined" style={{ fontSize: 14, color: "#D8C3B4" }}>expand_more</span>
          </button>
        </div>
      </nav>

      {/* Message navigation */}
      <header
        className="flex justify-between items-end"
        style={{ paddingTop: 96, paddingBottom: 32, paddingLeft: 24, paddingRight: 24, maxWidth: 1024, margin: "0 auto", width: "100%" }}
      >
        {/* Previous */}
        <div
          className={emailIndex > 0 ? "group cursor-pointer" : "opacity-30 cursor-default"}
          onClick={() => { if (emailIndex > 0) onNavigate(emails[emailIndex - 1], emailIndex - 1); }}
        >
          <p style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, letterSpacing: "0.15em", textTransform: "uppercase", color: "#D8C3B4", marginBottom: 8 }}>
            Previous Message
          </p>
          <div className="flex items-center gap-3" style={{ color: emailIndex > 0 ? "rgba(229,226,225,0.4)" : "rgba(229,226,225,0.15)" }}>
            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>arrow_back</span>
            <span style={{ fontFamily: "'Newsreader', serif", fontStyle: "italic", fontSize: 18 }}>
              {emailIndex > 0 ? (emails[emailIndex - 1].from[0] || emails[emailIndex - 1].subject) : "—"}
            </span>
          </div>
        </div>

        {/* Next */}
        <div
          className={emailIndex < emails.length - 1 ? "cursor-pointer text-right" : "opacity-30 cursor-default text-right"}
          onClick={() => { if (emailIndex < emails.length - 1) onNavigate(emails[emailIndex + 1], emailIndex + 1); }}
        >
          <p style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, letterSpacing: "0.15em", textTransform: "uppercase", color: "#D8C3B4", marginBottom: 8 }}>
            Upcoming Message
          </p>
          <div className="flex items-center gap-3 justify-end" style={{ color: emailIndex < emails.length - 1 ? "rgba(229,226,225,0.4)" : "rgba(229,226,225,0.15)" }}>
            <span style={{ fontFamily: "'Newsreader', serif", fontStyle: "italic", fontSize: 18 }}>
              {emailIndex < emails.length - 1 ? (emails[emailIndex + 1].from[0] || emails[emailIndex + 1].subject) : "—"}
            </span>
            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>arrow_forward</span>
          </div>
        </div>
      </header>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto" style={{ paddingBottom: 128 }}>
        <main style={{ maxWidth: 896, margin: "0 auto", padding: "0 24px" }}>
          {/* Metadata ribbon */}
          <div
            className="flex justify-between items-center"
            style={{
              background: "#0E0E0E",
              padding: "12px 24px",
              borderRadius: "0.75rem 0.75rem 0 0",
              borderBottom: "1px solid rgba(82,68,57,0.15)",
            }}
          >
            <div className="flex gap-6 items-center">
              <span
                className="flex items-center gap-2"
                style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: "#FFB77B" }}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 12, fontVariationSettings: "'FILL' 1" }}>verified</span>
                ENCRYPTED.JUNE
              </span>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: "#D8C3B4" }}>
                {dateStr}
              </span>
            </div>
            <div>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: "#D8C3B4" }}>
                ID: {email.uid.slice(0, 3).toUpperCase()}-XO-{email.uid.slice(-2).toUpperCase()}
              </span>
            </div>
          </div>

          {/* Email content card */}
          <article
            style={{
              background: "#1C1B1B",
              padding: "clamp(48px, 8vw, 80px)",
              borderRadius: "0 0 0.75rem 0.75rem",
              boxShadow: "0 40px 100px -20px rgba(0,0,0,0.7)",
              position: "relative",
              overflow: "hidden",
            }}
          >
            {/* Asymmetric accent */}
            <div
              style={{
                position: "absolute", top: 0, right: 0, width: 128, height: 128,
                background: "linear-gradient(135deg, rgba(255,183,123,0.05) 0%, transparent 100%)",
                pointerEvents: "none",
              }}
            />

            {/* Email header */}
            <header style={{ marginBottom: 64 }}>
              <h1
                style={{
                  fontFamily: "'Newsreader', serif",
                  fontSize: "clamp(2rem, 5vw, 3.5rem)",
                  color: "#E5E2E1",
                  lineHeight: 1.15,
                  letterSpacing: "-0.02em",
                  marginBottom: 32,
                  maxWidth: 640,
                }}
              >
                {email.subject}
              </h1>
              <div className="flex items-center gap-4">
                <div
                  className="flex items-center justify-center"
                  style={{
                    width: 48, height: 48, borderRadius: "9999px",
                    background: "#353535",
                    border: "1px solid rgba(82,68,57,0.3)",
                    fontSize: 16, fontWeight: 700, color: "#FFB77B",
                    fontFamily: "'Inter', sans-serif",
                  }}
                >
                  {getInitials(email.from[0] || email.from[1] || "?")}
                </div>
                <div>
                  <p style={{ fontSize: 14, fontWeight: 500, color: "#E5E2E1" }}>
                    {email.from[0] || email.from[1]}{" "}
                    <span style={{ color: "#D8C3B4", fontWeight: 400 }}>&lt;{email.from[1]}&gt;</span>
                  </p>
                  <p style={{ fontSize: 12, color: "#D8C3B4", marginTop: 2 }}>
                    to {email.to || "me"}
                  </p>
                </div>
              </div>
            </header>

            {/* Email body */}
            <section
              style={{
                fontFamily: "'Inter', sans-serif",
                color: "rgba(229,226,225,0.9)",
                lineHeight: 1.8,
                fontSize: 18,
                maxWidth: 672,
              }}
            >
              {body ? (
                /** biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized with DOMPurify */
                <div
                  dangerouslySetInnerHTML={{ __html: clean }}
                  style={{ maxWidth: "100%", overflowWrap: "break-word", wordBreak: "break-word" }}
                />
              ) : (
                <div className="flex justify-center" style={{ padding: "64px 0" }}>
                  <div
                    className="animate-spin rounded-full"
                    style={{
                      width: 20, height: 20,
                      border: "2px solid #353535",
                      borderTopColor: "#FFB77B",
                    }}
                  />
                </div>
              )}

              {/* Sign-off mark-read button */}
              <div style={{ paddingTop: 32 }}>
                <button
                  type="button"
                  onClick={() => onToggleRead(email)}
                  className="transition-opacity hover:opacity-70"
                  style={{ color: "#D8C3B4", fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
                    {email.isRead ? "mark_email_unread" : "mark_email_read"}
                  </span>
                  {email.isRead ? "Mark as unread" : "Mark as read"}
                </button>
              </div>
            </section>
          </article>
        </main>
      </div>
    </div>
  );
}

// ─── Tab constants ─────────────────────────────────────────────────────────────
const TABS = ["Focused", "Unread", "Starred"] as const;

// ─── Inbox Client ─────────────────────────────────────────────────────────────

export default function InboxClient({
  emails,
  isLoading,
  query,
}: {
  emails: Email[];
  isLoading: boolean;
  query: string;
}) {
  const [selectedEmail, setSelectedEmail] = useState<Email | null>(null);
  const [selectedEmailIndex, setSelectedEmailIndex] = useState<number>(-1);
  const [body, setBody] = useState("");
  const [isReaderOpen, setIsReaderOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<(typeof TABS)[number]>("Focused");
  const [localQuery, setLocalQuery] = useState(query);
  const { updateMessageReadStatus, clearMessageNewStatus, archiveMessage, snoozeMessage, senderRules, allowSender, blockSender } = useJazzInboxState();
  const { getToken } = useAuth();
  const { user } = useUser();
  const router = useRouter();

  const sortedEmails = useMemo(
    () => [...emails].sort((a, b) => Date.parse(b.date) - Date.parse(a.date)),
    [emails],
  );

  const blockedAddresses = React.useMemo(
    () => new Set(senderRules.filter((r) => r.rule === "block").map((r) => r.address)),
    [senderRules],
  );

  const filteredEmails = useMemo(() => {
    const now = new Date();
    let result = sortedEmails.filter((e) => {
      if (e.isArchived) return false;
      if (e.snoozedUntil && new Date(e.snoozedUntil) > now) return false;
      if (blockedAddresses.has(e.from[1])) return false;
      return true;
    });
    if (activeTab === "Unread") result = result.filter((e) => !e.isRead);
    return result;
  }, [sortedEmails, activeTab, blockedAddresses]);

  const gatekeeperCandidates = useMemo(() => {
    const ruledAddresses = new Set(senderRules.map((r) => r.address));
    const addressCount = new Map<string, number>();
    for (const email of sortedEmails) {
      const addr = email.from[1];
      addressCount.set(addr, (addressCount.get(addr) ?? 0) + 1);
    }
    return sortedEmails
      .filter((e) => addressCount.get(e.from[1]) === 1 && !ruledAddresses.has(e.from[1]))
      .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
      .slice(0, 3);
  }, [sortedEmails, senderRules]);

  const unreadCount = sortedEmails.filter((e) => !e.isRead).length;

  const toggleRead = async (email: Email) => {
    if (!email) return;
    const token = await getToken();
    await fetch(
      `/api/mail/emails/mailbox/${encodeURIComponent(email.mailboxAddress)}/${email.uid}?isRead=${email.isRead}`,
      {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      },
    );
    const updatedEmail = { ...email, isRead: !email.isRead, isNew: email.isRead ? email.isNew : false };
    updateMessageReadStatus({ uid: email.uid, mailboxAddress: email.mailboxAddress }, updatedEmail.isRead);
    if (!email.isRead) clearMessageNewStatus({ uid: email.uid, mailboxAddress: email.mailboxAddress });
    if (selectedEmail && getEmailKey(selectedEmail) === getEmailKey(email)) {
      setSelectedEmail(updatedEmail);
    }
  };

  const fetchBody = async (email: Email) => {
    const token = await getToken();
    const response = await fetch(
      `/api/mail/emails/${email.uid}?mailbox=${encodeURIComponent(email.mailboxAddress)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!response.ok) return "";
    const res = await response.json();
    const nextBody = typeof res.body === "string" ? res.body : "";
    setBody(nextBody);
    return nextBody;
  };

  const openEmail = async (email: Email, index?: number) => {
    setSelectedEmail({ ...email, isNew: false });
    setSelectedEmailIndex(
      index ?? filteredEmails.findIndex((e) => getEmailKey(e) === getEmailKey(email)),
    );
    setBody("");
    setIsReaderOpen(true);
    clearMessageNewStatus({ uid: email.uid, mailboxAddress: email.mailboxAddress });
    await fetchBody(email);
  };

  const closeReader = () => {
    setIsReaderOpen(false);
    setBody("");
  };

  const handleArchive = React.useCallback(async () => {
    if (!selectedEmail) return;
    const token = await getToken();
    const response = await fetch(
      `/api/mail/emails/mailbox/${encodeURIComponent(selectedEmail.mailboxAddress)}/${selectedEmail.uid}/archive`,
      { method: "POST", headers: { Authorization: `Bearer ${token}` } },
    );
    if (response.ok) {
      archiveMessage({ uid: selectedEmail.uid, mailboxAddress: selectedEmail.mailboxAddress });
      closeReader();
    }
  }, [selectedEmail, getToken, archiveMessage, closeReader]);

  const [isComposeOpen, setIsComposeOpen] = useState(false);
  const [composeTo, setComposeTo] = useState("");
  const [composeSubject, setComposeSubject] = useState("");
  const [composeBody, setComposeBody] = useState("");
  const [composeError, setComposeError] = useState<string | null>(null);
  const [composeReplyTo, setComposeReplyTo] = useState<string | undefined>();
  const [composeSending, setComposeSending] = useState(false);
  const [isSendLaterOpen, setIsSendLaterOpen] = useState(false);

  const [isSnoozeOpen, setIsSnoozeOpen] = useState(false);

  function getSnoozeDate(preset: "today" | "tomorrow" | "nextWeek"): Date {
    const d = new Date();
    if (preset === "today") { d.setHours(d.getHours() + 3); return d; }
    if (preset === "tomorrow") { d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d; }
    const day = d.getDay();
    const daysUntilMonday = day === 0 ? 1 : 8 - day;
    d.setDate(d.getDate() + daysUntilMonday);
    d.setHours(9, 0, 0, 0);
    return d;
  }

  const handleSnooze = (until: Date) => {
    if (!selectedEmail) return;
    snoozeMessage(
      { uid: selectedEmail.uid, mailboxAddress: selectedEmail.mailboxAddress },
      until.toISOString(),
    );
    setIsSnoozeOpen(false);
    closeReader();
  };

  const openReply = React.useCallback(() => {
    if (!selectedEmail) return;
    setComposeTo(selectedEmail.from[1]);
    const subject = selectedEmail.subject.startsWith("Re:")
      ? selectedEmail.subject
      : `Re: ${selectedEmail.subject}`;
    setComposeSubject(subject);
    setComposeBody(`\n\n---\n${body}`); // body = current reader body state
    setComposeReplyTo(selectedEmail.id);
    setComposeError(null);
    setIsComposeOpen(true);
  }, [selectedEmail, body]);

  const handleSend = async () => {
    if (!selectedEmail) return;
    setComposeSending(true);
    setComposeError(null);
    try {
      const token = await getToken();
      const res = await fetch("/api/mail/emails/send", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          mailbox: selectedEmail.mailboxAddress,
          to: composeTo, subject: composeSubject, body: composeBody,
          inReplyTo: composeReplyTo, references: composeReplyTo,
        }),
      });
      const result = await res.json();
      if (result.error === "INSUFFICIENT_SCOPE") {
        setComposeError("Reconnect your mailbox in Settings to enable sending.");
      } else if (result.error) {
        setComposeError(result.error);
      } else {
        setIsComposeOpen(false);
      }
    } catch {
      setComposeError("Network error. Please try again.");
    } finally {
      setComposeSending(false);
    }
  };

  const handleScheduleSend = async (sendAt: Date) => {
    if (!selectedEmail) return;
    setComposeSending(true);
    setComposeError(null);
    try {
      const token = await getToken();
      const res = await fetch("/api/mail/emails/schedule", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          mailbox: selectedEmail.mailboxAddress,
          to: composeTo, subject: composeSubject, body: composeBody,
          inReplyTo: composeReplyTo, references: composeReplyTo,
          sendAt: sendAt.toISOString(),
        }),
      });
      const result = await res.json();
      if (result.error) {
        setComposeError(result.error);
      } else {
        setIsComposeOpen(false);
        setIsSendLaterOpen(false);
      }
    } catch {
      setComposeError("Network error. Please try again.");
    } finally {
      setComposeSending(false);
    }
  };

  return (
    <div
      className="flex h-screen flex-col overflow-hidden"
      style={{ background: "#131313", fontFamily: "'Inter', sans-serif", color: "#E5E2E1" }}
    >
      {/* Full-screen reader overlay */}
      {isReaderOpen && selectedEmail && (
        <EmailReader
          email={selectedEmail}
          body={body}
          onClose={closeReader}
          onToggleRead={toggleRead}
          emails={filteredEmails}
          emailIndex={selectedEmailIndex}
          onNavigate={openEmail}
        />
      )}

      {/* ── Header ── */}
      <header
        className="fixed top-0 left-0 w-full flex justify-between items-center px-6 py-2"
        style={{
          background: "rgba(19,19,19,0.9)",
          backdropFilter: "blur(20px)",
          zIndex: 40,
        }}
      >
        <div className="flex items-center gap-8">
          <a
            href="/"
            style={{ fontFamily: "'Newsreader', serif", fontSize: 18, fontWeight: 500, letterSpacing: "-0.02em", color: "#E5E2E1" }}
          >
            June
          </a>
        </div>
        <div className="flex items-center gap-4">
          {/* Search input */}
          <div className="relative hidden lg:block">
            <div className="absolute inset-y-0 left-3 flex items-center pointer-events-none">
              <span className="material-symbols-outlined" style={{ color: "#D8C3B4", fontSize: 16 }}>search</span>
            </div>
            <input
              type="text"
              value={localQuery}
              onChange={(e) => setLocalQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const val = (e.target as HTMLInputElement).value.trim();
                  router.push(val ? `/inbox?query=${encodeURIComponent(val)}` : "/inbox");
                }
              }}
              placeholder="Search commands..."
              className="outline-none"
              style={{
                background: "#1C1B1B",
                border: "1px solid rgba(82,68,57,0.3)",
                borderRadius: "9999px",
                padding: "4px 16px 4px 36px",
                fontSize: 12,
                width: 192,
                color: "#E5E2E1",
              }}
            />
          </div>
            <div className="flex items-center gap-1" style={{ background: "#1C1B1B", borderRadius: "1rem", padding: "6px" }}>
          <button
            type="button"
            className="p-2 transition-colors"
            style={{ color: "#D8C3B4", borderRadius: "0.5rem" }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "#FFB77B")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "#D8C3B4")}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 20 }}>palette</span>
          </button>
          <button
            type="button"
            onClick={() => router.push("/settings")}
            className="p-2 transition-colors"
            style={{ color: "#D8C3B4", borderRadius: "0.5rem" }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "#FFB77B")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "#D8C3B4")}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 20 }}>settings</span>
          </button>
          <div style={{ width: 1, height: 16, background: "rgba(82,68,57,0.5)", margin: "0 4px" }} />
          <button
            type="button"
            className="flex items-center gap-2 transition-all"
            style={{ padding: "4px 8px 4px 4px", borderRadius: "0.75rem" }}
          >
            <div
              className="flex items-center justify-center overflow-hidden"
              style={{
                width: 28, height: 28, borderRadius: "9999px",
                background: "rgba(200,128,63,0.2)",
                border: "1px solid rgba(255,183,123,0.2)",
                fontSize: 11, fontWeight: 700, color: "#FFB77B",
                fontFamily: "'Inter', sans-serif",
              }}
            >
              {(user?.firstName?.[0] ?? "U").toUpperCase()}
            </div>
            <span className="material-symbols-outlined" style={{ fontSize: 14, color: "#D8C3B4" }}>expand_more</span>
          </button>
        </div>
        </div>
      </header>

      {/* ── Scrollable body ── */}
      <main className="flex-1 overflow-y-auto" style={{ paddingTop: 80, paddingBottom: 128, paddingLeft: 16, paddingRight: 16 }}>
        <div className="mx-auto" style={{ maxWidth: 1024 }}>

          {/* Metadata ribbon */}
          <div
            className="flex items-center justify-between mb-8"
            style={{
              padding: "4px 12px",
              background: "#0E0E0E",
              borderLeft: "2px solid #FFB77B",
            }}
          >
            <div className="flex items-center gap-4">
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, letterSpacing: "0.15em", textTransform: "uppercase", color: "#D8C3B4" }}>Command Center</span>
              <span style={{ width: 4, height: 4, borderRadius: "9999px", background: "rgba(82,68,57,0.5)", display: "inline-block" }} />
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, letterSpacing: "0.15em", textTransform: "uppercase", color: "#FFB77B" }}>
                {unreadCount} Decisions Pending
              </span>
            </div>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, letterSpacing: "0.15em", textTransform: "uppercase", color: "rgba(216,195,180,0.5)" }}>
              Last Synced: {new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} GMT
            </span>
          </div>

          {/* Gatekeeper */}
          {gatekeeperCandidates.length > 0 && (
            <section style={{ marginBottom: 48 }}>
              <div className="flex items-baseline gap-3 mb-6">
                <h2 style={{ fontFamily: "'Newsreader', serif", fontSize: 30, color: "#E5E2E1" }}>The Gatekeeper</h2>
                <span style={{ fontFamily: "'Newsreader', serif", fontStyle: "italic", fontSize: 18, color: "#D8C3B4" }}>
                  Reviewing {gatekeeperCandidates.length} first-time sender{gatekeeperCandidates.length !== 1 ? "s" : ""}
                </span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {gatekeeperCandidates.map((email) => (
                  <div
                    key={`${email.mailboxAddress}:${email.uid}`}
                    className="group flex flex-col gap-3 transition-all"
                    style={{ background: "#1C1B1B", border: "1px solid rgba(82,68,57,0.15)", padding: 16, borderRadius: "0.75rem" }}
                  >
                    <div className="flex items-center gap-3">
                      <div
                        className="flex items-center justify-center"
                        style={{ width: 32, height: 32, borderRadius: "9999px", background: "rgba(82,68,57,0.3)", color: "rgba(255,183,123,0.8)", fontSize: 14, fontWeight: 700 }}
                      >
                        {(email.from[0]?.[0] ?? email.from[1]?.[0] ?? "?").toUpperCase()}
                      </div>
                      <div className="flex flex-col">
                        <h3 style={{ fontSize: 14, fontWeight: 500, color: "#E5E2E1" }}>{email.from[0] || email.from[1]}</h3>
                        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 8, color: "rgba(216,195,180,0.4)", letterSpacing: "0.1em", textTransform: "uppercase" }}>{email.from[1]}</span>
                      </div>
                    </div>
                    <p style={{ fontSize: 12, color: "rgba(216,195,180,0.7)", lineHeight: 1.6, minHeight: "3rem" }}>{email.subject}</p>
                    <div className="flex gap-4 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button type="button" onClick={() => allowSender(email.from[1])} className="hover:underline"
                        style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "#FFB77B" }}>
                        Allow
                      </button>
                      <button type="button" onClick={() => blockSender(email.from[1])} className="hover:opacity-70"
                        style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "rgba(216,195,180,0.6)" }}>
                        Block
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Inbox section */}
          <section
            style={{
              background: "#0E0E0E",
              borderRadius: "0.75rem",
              border: "1px solid rgba(82,68,57,0.1)",
              overflow: "hidden",
            }}
          >
            {/* Tabs row */}
            <div
              className="flex items-center justify-between"
              style={{ padding: "12px 20px", borderBottom: "1px solid rgba(82,68,57,0.15)", background: "rgba(28,27,27,0.3)" }}
            >
              <div className="flex gap-6">
                {TABS.map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setActiveTab(tab)}
                    style={{
                      fontFamily: "'Inter', sans-serif",
                      fontSize: 12,
                      fontWeight: activeTab === tab ? 600 : 500,
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                      color: activeTab === tab ? "#FFB77B" : "rgba(216,195,180,0.5)",
                      transition: "color 0.15s",
                    }}
                    onMouseEnter={(e) => { if (activeTab !== tab) e.currentTarget.style.color = "#E5E2E1"; }}
                    onMouseLeave={(e) => { if (activeTab !== tab) e.currentTarget.style.color = "rgba(216,195,180,0.5)"; }}
                  >
                    {tab}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-3">
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: "rgba(216,195,180,0.3)", letterSpacing: "0.1em", textTransform: "uppercase" }}>Sort: Recent</span>
                <button type="button" style={{ color: "rgba(216,195,180,0.4)" }}>
                  <span className="material-symbols-outlined" style={{ fontSize: 16 }}>filter_list</span>
                </button>
              </div>
            </div>

            {/* Email list */}
            <div style={{ borderTop: "none" }}>
              {/* Empty / loading */}
              {!isLoading && filteredEmails.length === 0 && (
                <div className="flex flex-col items-center justify-center" style={{ padding: "64px 0" }}>
                  <span className="material-symbols-outlined" style={{ fontSize: 36, color: "#353535", marginBottom: 12 }}>mail</span>
                  <p style={{ fontSize: 14, color: "#D8C3B4" }}>
                    {query ? `No emails matched "${query}".` : "Your inbox is empty."}
                  </p>
                </div>
              )}
              {isLoading && filteredEmails.length === 0 && (
                <div className="flex flex-col items-center justify-center" style={{ padding: "64px 0" }}>
                  <div
                    className="animate-spin rounded-full"
                    style={{ width: 20, height: 20, border: "2px solid #353535", borderTopColor: "#FFB77B", marginBottom: 12 }}
                  />
                  <p style={{ fontSize: 12, color: "#D8C3B4" }}>
                    {query ? `Searching for "${query}"…` : "Loading emails…"}
                  </p>
                </div>
              )}

              {/* Rows */}
              <ul style={{ borderTop: `1px solid rgba(82,68,57,0.05)` }}>
                {filteredEmails.map((email, index) => {
                  const isSelected = selectedEmail && getEmailKey(selectedEmail) === getEmailKey(email);
                  const isUnread = !email.isRead;
                  return (
                    <li
                      key={getEmailKey(email)}
                      className="flex items-center group cursor-pointer transition-colors"
                      style={{
                        padding: "10px 20px",
                        borderBottom: "1px solid rgba(82,68,57,0.07)",
                        background: isSelected ? "rgba(255,183,123,0.04)" : "transparent",
                      }}
                      onClick={() => openEmail(email, index)}
                      onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = "rgba(255,183,123,0.02)"; }}
                      onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = "transparent"; }}
                    >
                      {/* Unread dot */}
                      <div className="flex-shrink-0 mr-4">
                        <div
                          style={{
                            width: 6, height: 6, borderRadius: "9999px",
                            background: isUnread ? "#FFB77B" : "transparent",
                            boxShadow: isUnread ? "0 0 8px rgba(255,183,123,0.4)" : "none",
                            border: isUnread ? "none" : "1px solid rgba(82,68,57,0.5)",
                          }}
                        />
                      </div>

                      {/* Sender */}
                      <div
                        className="flex-shrink-0 truncate"
                        style={{
                          width: 160,
                          fontSize: 12,
                          fontWeight: isUnread ? 600 : 500,
                          color: isUnread ? "#E5E2E1" : "#D8C3B4",
                        }}
                      >
                        {email.from[0] || email.from[1]}
                      </div>

                      {/* Subject + snippet */}
                      <div className="flex-1 truncate" style={{ fontSize: 12, paddingRight: 24 }}>
                        <span style={{ color: isUnread ? "rgba(255,183,123,0.9)" : "rgba(229,226,225,0.8)", fontWeight: isUnread ? 500 : 400 }}>
                          {email.subject}
                        </span>
                        <span style={{ color: "rgba(229,226,225,0.4)" }}> — </span>
                        <span style={{ color: "rgba(216,195,180,0.5)" }}>Click to read</span>
                      </div>

                      {/* Timestamp */}
                      <div className="flex-shrink-0 flex items-center gap-3">
                        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: "rgba(216,195,180,0.4)" }}>
                          {formatDate(email.date)}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>

            {/* Footer status */}
            <div
              className="flex justify-between items-center"
              style={{ padding: "8px 20px", background: "rgba(28,27,27,0.3)", borderTop: "1px solid rgba(82,68,57,0.1)" }}
            >
              <div className="flex items-center gap-2">
                <span style={{ width: 6, height: 6, borderRadius: "9999px", background: "rgba(52,211,153,0.5)", display: "inline-block" }} className="animate-pulse" />
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 8, color: "rgba(216,195,180,0.6)", letterSpacing: "0.1em", textTransform: "uppercase" }}>System Operational</span>
              </div>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 8, color: "rgba(216,195,180,0.3)", letterSpacing: "0.1em", textTransform: "uppercase" }}>
                {sortedEmails.length} Messages
              </span>
            </div>
          </section>
        </div>
      </main>

            {/* Floating Navigation Bar */}
      <nav
        className="fixed flex justify-center items-center gap-1"
        style={{
          bottom: 32, left: "50%", transform: "translateX(-50%)", zIndex: 50,
          background: "rgba(28,27,27,0.9)", backdropFilter: "blur(16px)",
          borderRadius: "1rem", padding: "8px 16px",
          boxShadow: "0 25px 50px -12px rgba(0,0,0,0.4)",
          border: "1px solid rgba(82,68,57,0.2)",
        }}
      >
        {/* Archive */}
        <button
          type="button"
          onClick={handleArchive}
          disabled={!selectedEmail}
          className="flex flex-col items-center justify-center transition-all"
          style={{
            padding: "8px 16px", borderRadius: "0.75rem",
            color: selectedEmail ? "rgba(229,226,225,0.7)" : "rgba(229,226,225,0.3)",
            cursor: selectedEmail ? "pointer" : "not-allowed",
          }}
          onMouseEnter={(e) => { if (selectedEmail) { e.currentTarget.style.background = "#353535"; e.currentTarget.style.color = "#E5E2E1"; } }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = selectedEmail ? "rgba(229,226,225,0.7)" : "rgba(229,226,225,0.3)"; }}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 20, marginBottom: 4 }}>archive</span>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, letterSpacing: "0.05em", textTransform: "uppercase" }}>Archive</span>
        </button>

        {/* Snooze */}
        <div className="relative">
          <button
            type="button"
            onClick={() => selectedEmail && setIsSnoozeOpen((o) => !o)}
            disabled={!selectedEmail}
            className="flex flex-col items-center justify-center transition-all"
            style={{
              padding: "8px 16px", borderRadius: "0.75rem",
              color: selectedEmail ? "rgba(229,226,225,0.7)" : "rgba(229,226,225,0.3)",
              cursor: selectedEmail ? "pointer" : "not-allowed",
            }}
            onMouseEnter={(e) => { if (selectedEmail) { e.currentTarget.style.background = "#353535"; e.currentTarget.style.color = "#E5E2E1"; } }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = selectedEmail ? "rgba(229,226,225,0.7)" : "rgba(229,226,225,0.3)"; }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 20, marginBottom: 4 }}>schedule</span>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, letterSpacing: "0.05em", textTransform: "uppercase" }}>Snooze</span>
          </button>

          {isSnoozeOpen && (
            <div
              className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2"
              style={{ background: "#1C1B1B", border: "1px solid rgba(82,68,57,0.3)", borderRadius: "0.75rem", padding: 12, minWidth: 176, zIndex: 60 }}
            >
              {([
                { label: "Later today", fn: () => handleSnooze(getSnoozeDate("today")) },
                { label: "Tomorrow", fn: () => handleSnooze(getSnoozeDate("tomorrow")) },
                { label: "Next week", fn: () => handleSnooze(getSnoozeDate("nextWeek")) },
              ] as const).map(({ label, fn }) => (
                <button
                  key={label} type="button" onClick={fn}
                  className="block w-full text-left transition-opacity hover:opacity-70"
                  style={{ padding: "6px 8px", fontSize: 12, color: "#E5E2E1", borderRadius: "0.5rem" }}
                >
                  {label}
                </button>
              ))}
              {/* Custom date/time picker */}
              <div style={{ borderTop: "1px solid rgba(82,68,57,0.2)", marginTop: 8, paddingTop: 8 }}>
                <label style={{ fontSize: 10, color: "#D8C3B4", fontFamily: "'JetBrains Mono', monospace", textTransform: "uppercase", letterSpacing: "0.05em", display: "block", marginBottom: 4 }}>
                  Custom
                </label>
                <input
                  type="datetime-local"
                  min={new Date().toISOString().slice(0, 16)}
                  onChange={(e) => {
                    if (e.target.value) handleSnooze(new Date(e.target.value));
                  }}
                  style={{ background: "#131313", border: "1px solid rgba(82,68,57,0.3)", borderRadius: "0.5rem", padding: "4px 8px", fontSize: 11, color: "#E5E2E1", width: "100%", outline: "none" }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Reply — wired in Task 14 */}
        <button
          type="button"
          onClick={openReply}
          disabled={!selectedEmail}
          className="flex flex-col items-center justify-center transition-all"
          style={{
            padding: "8px 16px", borderRadius: "0.75rem",
            color: selectedEmail ? "rgba(229,226,225,0.7)" : "rgba(229,226,225,0.3)",
            cursor: selectedEmail ? "pointer" : "not-allowed",
          }}
          onMouseEnter={(e) => { if (selectedEmail) { e.currentTarget.style.background = "#353535"; e.currentTarget.style.color = "#E5E2E1"; } }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = selectedEmail ? "rgba(229,226,225,0.7)" : "rgba(229,226,225,0.3)"; }}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 20, marginBottom: 4 }}>reply</span>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, letterSpacing: "0.05em", textTransform: "uppercase" }}>Reply</span>
        </button>
      </nav>

      {/* ── FAB compose ── */}
      <button
        type="button"
        className="fixed flex items-center justify-center transition-all hover:scale-105 active:scale-95"
        style={{
          bottom: 24, right: 24,
          width: 56, height: 56, borderRadius: "1rem", zIndex: 40,
          background: "linear-gradient(135deg, #FFB77B, #C8803F)",
          boxShadow: "0 10px 25px -5px rgba(255,183,123,0.15)",
          color: "#4D2700",
        }}
        title="Compose"
      >
        <span className="material-symbols-outlined" style={{ fontSize: 22 }}>edit</span>
      </button>

      {isComposeOpen && (
        <div className="fixed inset-0 z-50 flex flex-col overflow-hidden" style={{ background: "#131313", fontFamily: "'Inter', sans-serif" }}>
          <nav
            className="fixed top-0 left-0 w-full flex justify-between items-center px-6 py-3"
            style={{ background: "rgba(19,19,19,0.8)", backdropFilter: "blur(20px)", zIndex: 50 }}
          >
            <span style={{ fontFamily: "'Newsreader', serif", fontSize: 20, fontWeight: 500, color: "#E5E2E1" }}>New Message</span>
            <button
              type="button"
              onClick={() => {
                if (composeBody.trim() && !window.confirm("Discard this message?")) return;
                setIsComposeOpen(false);
              }}
              style={{ color: "#D8C3B4" }}
            >
              <span className="material-symbols-outlined">close</span>
            </button>
          </nav>

          <main style={{ maxWidth: 768, margin: "0 auto", width: "100%", padding: "96px 24px 24px" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <input
                type="email" placeholder="To" value={composeTo}
                onChange={(e) => setComposeTo(e.target.value)}
                style={{ background: "#1C1B1B", border: "1px solid rgba(82,68,57,0.3)", borderRadius: "0.5rem", padding: "10px 14px", color: "#E5E2E1", fontSize: 14, outline: "none" }}
              />
              <input
                type="text" placeholder="Subject" value={composeSubject}
                onChange={(e) => setComposeSubject(e.target.value)}
                style={{ background: "#1C1B1B", border: "1px solid rgba(82,68,57,0.3)", borderRadius: "0.5rem", padding: "10px 14px", color: "#E5E2E1", fontSize: 14, outline: "none" }}
              />
              <textarea
                placeholder="Write your message…" value={composeBody} rows={14}
                onChange={(e) => setComposeBody(e.target.value)}
                style={{ background: "#1C1B1B", border: "1px solid rgba(82,68,57,0.3)", borderRadius: "0.5rem", padding: "10px 14px", color: "#E5E2E1", fontSize: 14, outline: "none", resize: "vertical" }}
              />
              {composeError && <p style={{ fontSize: 12, color: "#FFB77B" }}>{composeError}</p>}
              <div className="flex gap-3 items-center">
                <button
                  type="button" onClick={handleSend} disabled={composeSending}
                  style={{ background: "linear-gradient(135deg, #FFB77B, #C8803F)", color: "#4D2700", padding: "10px 24px", borderRadius: "0.75rem", fontWeight: 600, fontSize: 13, opacity: composeSending ? 0.6 : 1 }}
                >
                  {composeSending ? "Sending…" : "Send"}
                </button>
                <div className="relative">
                  <button
                    type="button" disabled={composeSending}
                    onClick={() => setIsSendLaterOpen((o) => !o)}
                    style={{ background: "#1C1B1B", border: "1px solid rgba(82,68,57,0.3)", color: "#D8C3B4", padding: "10px 16px", borderRadius: "0.75rem", fontSize: 13 }}
                  >
                    Send Later
                  </button>
                  {isSendLaterOpen && (
                    <div style={{ position: "absolute", bottom: "calc(100% + 8px)", left: 0, background: "#1C1B1B", border: "1px solid rgba(82,68,57,0.3)", borderRadius: "0.75rem", padding: 12, minWidth: 176, zIndex: 60 }}>
                      {([
                        { label: "Later today", fn: () => handleScheduleSend(getSnoozeDate("today")) },
                        { label: "Tomorrow", fn: () => handleScheduleSend(getSnoozeDate("tomorrow")) },
                        { label: "Next week", fn: () => handleScheduleSend(getSnoozeDate("nextWeek")) },
                      ] as const).map(({ label, fn }) => (
                        <button key={label} type="button" onClick={fn} className="block w-full text-left hover:opacity-70"
                          style={{ padding: "6px 8px", fontSize: 12, color: "#E5E2E1", borderRadius: "0.5rem" }}>
                          {label}
                        </button>
                      ))}
                      <div style={{ borderTop: "1px solid rgba(82,68,57,0.2)", marginTop: 8, paddingTop: 8 }}>
                        <label style={{ fontSize: 10, color: "#D8C3B4", fontFamily: "'JetBrains Mono', monospace", textTransform: "uppercase", display: "block", marginBottom: 4 }}>Custom</label>
                        <input type="datetime-local" min={new Date().toISOString().slice(0, 16)}
                          onChange={(e) => { if (e.target.value) handleScheduleSend(new Date(e.target.value)); }}
                          style={{ background: "#131313", border: "1px solid rgba(82,68,57,0.3)", borderRadius: "0.5rem", padding: "4px 8px", fontSize: 11, color: "#E5E2E1", width: "100%", outline: "none" }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </main>
        </div>
      )}
    </div>
  );
}
