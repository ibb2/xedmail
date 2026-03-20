"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

const initialInboxes = [
  { id: 1, name: "Work", email: "john@company.com", status: "connected" },
  { id: 2, name: "Personal", email: "john@gmail.com", status: "connected" },
  { id: 3, name: "Newsletters", email: "john+news@gmail.com", status: "error" },
] as const;

const statusStyles = {
  connected: "bg-emerald-500",
  error: "bg-red-500",
  inactive: "bg-gray-400",
} as const;

type Inbox = {
  id: number;
  name: string;
  email: string;
  status: keyof typeof statusStyles;
};

export default function AccountsPage() {
  const router = useRouter();
  const rowRefs = useRef<Record<string, HTMLLIElement | null>>({});
  const [inboxes, setInboxes] = useState<Inbox[]>([...initialInboxes]);
  const [activeInbox, setActiveInbox] = useState("Work");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");

  const jumpToInbox = (inboxName: string) => {
    setActiveInbox(inboxName);
    rowRefs.current[inboxName]?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
    });
  };

  const handleSelect = (inboxName: string) => {
    setActiveInbox(inboxName);
    router.push(`/inbox/${encodeURIComponent(inboxName.toLowerCase())}`);
  };

  const handleRemove = (id: number) => {
    setInboxes((current) => {
      const next = current.filter((inbox) => inbox.id !== id);
      if (!next.some((inbox) => inbox.name === activeInbox) && next[0]) {
        setActiveInbox(next[0].name);
      }
      return next;
    });
  };

  const handleConnect = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextName = name.trim();
    const nextEmail = email.trim();
    if (!nextName || !nextEmail) return;

    const nextInbox = {
      id: Date.now(),
      name: nextName,
      email: nextEmail,
      status: "inactive" as const,
    };

    setInboxes((current) => [...current, nextInbox]);
    setActiveInbox(nextName);
    setName("");
    setEmail("");
  };

  return (
    <main className="min-h-screen bg-white px-4 py-10 sm:px-6">
      <div className="mx-auto w-full max-w-4xl">
        <header className="mb-8">
          <Link
            href="/"
            className="text-sm text-gray-500 transition hover:text-gray-900"
          >
            ← Back
          </Link>
          <h1 className="mt-4 text-3xl font-medium tracking-tight text-gray-900">
            Accounts
          </h1>
          <p className="mt-2 text-sm text-gray-500">
            Manage your connected inboxes
          </p>
        </header>

        <section className="rounded-3xl border border-gray-200 bg-white p-4 sm:p-6">
          <div className="mb-5 flex flex-wrap gap-2">
            {inboxes.map((inbox) => (
              <button
                type="button"
                key={inbox.id}
                onClick={() => jumpToInbox(inbox.name)}
                className={`rounded-full px-3 py-1 text-xs transition ${
                  activeInbox === inbox.name
                    ? "bg-gray-900 text-white"
                    : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                {inbox.name}
              </button>
            ))}
          </div>

          <ul className="divide-y divide-gray-100">
            {inboxes.map((inbox) => (
              <li
                key={inbox.id}
                ref={(node) => {
                  rowRefs.current[inbox.name] = node;
                }}
                className={`flex flex-col gap-4 py-4 sm:flex-row sm:items-center sm:justify-between ${
                  activeInbox === inbox.name
                    ? "border-l-2 border-blue-300 bg-blue-50/70 pl-4"
                    : "pl-[18px]"
                }`}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-3">
                    <span
                      className={`size-2.5 rounded-full ${statusStyles[inbox.status]}`}
                    />
                    <p className="text-sm font-medium text-gray-900">
                      {inbox.name}
                    </p>
                  </div>
                  <p className="mt-1 truncate pl-5 text-sm text-gray-500">
                    {inbox.email}
                  </p>
                </div>

                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    onClick={() => handleSelect(inbox.name)}
                    className="rounded-full border border-gray-200 px-4 py-2 text-sm text-gray-700 transition hover:border-gray-300 hover:text-gray-900"
                  >
                    Select
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRemove(inbox.id)}
                    className="rounded-full border border-gray-200 px-4 py-2 text-sm text-gray-500 transition hover:border-red-200 hover:text-red-600"
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>

          <form
            onSubmit={handleConnect}
            className="mt-6 flex flex-col gap-3 sm:flex-row"
          >
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Inbox name"
              className="min-w-0 flex-1 rounded-full border border-gray-200 px-5 py-3 text-sm text-gray-900 outline-none transition focus:border-gray-300 focus:ring-4 focus:ring-gray-100"
            />
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="Email address"
              className="min-w-0 flex-1 rounded-full border border-gray-200 px-5 py-3 text-sm text-gray-900 outline-none transition focus:border-gray-300 focus:ring-4 focus:ring-gray-100"
            />
            <button
              type="submit"
              className="rounded-full bg-gray-900 px-5 py-3 text-sm font-medium text-white transition hover:bg-gray-800"
            >
              Connect
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}
