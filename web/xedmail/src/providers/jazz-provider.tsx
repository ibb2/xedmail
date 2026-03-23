"use client";

import { AuthProvider } from "jazz-tools/better-auth/auth/react";
import { jazzPluginClient } from "jazz-tools/better-auth/auth/client";
import { createAuthClient } from "better-auth/client";
import { authClient } from "@/lib/auth-client";

type JazzAuthClient = ReturnType<typeof createAuthClient<{ plugins: [ReturnType<typeof jazzPluginClient>] }>>;
import { co, InMemoryKVStore, KvStoreContext } from "jazz-tools";
import { LocalStorageKVStore } from "jazz-tools/browser";
import {
  JazzReactProvider,
  useAccount,
} from "jazz-tools/react";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import {
  JazzInboxState,
  JazzMailAccount,
  JazzRecentSearch,
  JazzScheduledEmail,
  JazzSenderRule,
} from "@/lib/jazz-schema";
import type { EmailDto, FolderDto, MailboxDto } from "@/lib/mail-types";

type JazzInboxContextValue = {
  isLoaded: boolean;
  messages: EmailDto[];
  folders: FolderDto[];
  mailboxes: MailboxDto[];
  scheduledEmails: Array<{
    id: string;
    to: string;
    subject: string;
    sendAt: string;
  }>;
  senderRules: Array<{ address: string; rule: "allow" | "block" }>;
  syncInbox: (payload: {
    messages: EmailDto[];
    folders: FolderDto[];
    mailboxes: MailboxDto[];
  }) => void;
  updateMessageReadStatus: (
    target: Pick<EmailDto, "uid" | "mailboxAddress">,
    isRead: boolean,
  ) => void;
  clearMessageNewStatus: (
    target: Pick<EmailDto, "uid" | "mailboxAddress">,
  ) => void;
  archiveMessage: (target: Pick<EmailDto, "uid" | "mailboxAddress">) => void;
  snoozeMessage: (
    target: Pick<EmailDto, "uid" | "mailboxAddress">,
    until: string | undefined,
  ) => void;
  allowSender: (address: string) => void;
  blockSender: (address: string) => void;
  syncScheduledEmails: (
    emails: Array<{ id: string; to: string; subject: string; sendAt: string }>,
  ) => void;
  recentSearches: Array<{ query: string; searchedAt: string }>;
  addRecentSearch: (query: string) => void;
};

const JazzInboxContext = createContext<JazzInboxContextValue | null>(null);
const JAZZ_AUTH_SECRET_STORAGE_KEY = "june-jazz-auth-secret";

function getSyncConfig() {
  const peer = process.env.NEXT_PUBLIC_JAZZ_SYNC_PEER;
  if (peer && (peer.startsWith("ws://") || peer.startsWith("wss://"))) {
    return { peer: peer as `ws://${string}` | `wss://${string}` };
  }

  return { when: "never" as const };
}

function setupKvStore() {
  KvStoreContext.getInstance().initialize(
    typeof window === "undefined"
      ? new InMemoryKVStore()
      : new LocalStorageKVStore(),
  );
}


function JazzInboxStateProvider({ children }: { children: React.ReactNode }) {
  const me = useAccount(JazzMailAccount, {
    resolve: {
      root: {
        inboxState: {
          mailboxes: { $each: true },
          folders: { $each: true },
          messages: { $each: true },
          senderRules: { $each: true },
          scheduledEmails: { $each: true },
          recentSearches: { $each: true },
        },
      },
    },
  });

  const contextValue = useMemo<JazzInboxContextValue>(() => {
    if (!me.$isLoaded) {
      return {
        isLoaded: false,
        messages: [],
        folders: [],
        mailboxes: [],
        scheduledEmails: [],
        senderRules: [],
        syncInbox: () => undefined,
        updateMessageReadStatus: () => undefined,
        clearMessageNewStatus: () => undefined,
        archiveMessage: () => undefined,
        snoozeMessage: () => undefined,
        allowSender: () => undefined,
        blockSender: () => undefined,
        syncScheduledEmails: () => undefined,
        recentSearches: [],
        addRecentSearch: () => undefined,
      };
    }

    const owner = me.root.$jazz.owner;

    const ensureInboxState = () => {
      const existingState = me.root.inboxState;
      if (existingState) {
        // Initialize missing lists for users who had inboxState before this feature
        if (!existingState.senderRules) {
          existingState.$jazz.set(
            "senderRules",
            co.list(JazzSenderRule).create([], { owner }),
          );
        }
        if (!existingState.scheduledEmails) {
          existingState.$jazz.set(
            "scheduledEmails",
            co.list(JazzScheduledEmail).create([], { owner }),
          );
        }
        if (!existingState.recentSearches) {
          existingState.$jazz.set(
            "recentSearches",
            co.list(JazzRecentSearch).create([], { owner }),
          );
        }
        return existingState;
      }

      const inboxState = JazzInboxState.create(
        {
          mailboxes: [],
          folders: [],
          messages: [],
          senderRules: [],
          scheduledEmails: [],
          recentSearches: [],
          lastSyncedAt: new Date().toISOString(),
        },
        { owner },
      );

      me.root.$jazz.set("inboxState", inboxState);
      return inboxState;
    };

    const mapMessages = (state: any): EmailDto[] =>
      state.messages.map((m: any) => ({
        id: m.id,
        uid: m.uid,
        mailboxAddress: m.mailboxAddress,
        messageId: m.messageId,
        subject: m.subject,
        from: [m.fromName, m.fromAddress],
        to: m.to,
        body: m.body,
        date: m.date,
        isRead: m.isRead,
        isNew: m.isNew ?? false,
        snoozedUntil: m.snoozedUntil,
        isArchived: m.isArchived ?? false,
      }));

    const mapFolders = (state: any): FolderDto[] =>
      state.folders.map((folder: any) => ({
        id: folder.id,
        name: folder.name,
        path: folder.path,
        unread: folder.unread,
        total: folder.total,
      }));

    const mapMailboxes = (state: any): MailboxDto[] =>
      state.mailboxes.map((mailbox: any) => ({
        id: mailbox.id,
        emailAddress: mailbox.emailAddress,
        image: mailbox.image ?? null,
      }));

    const syncInbox = (payload: {
      messages: EmailDto[];
      folders: FolderDto[];
      mailboxes: MailboxDto[];
    }) => {
      const state = ensureInboxState();
      const isInitialSync = state.messages.length === 0;

      // Build map of existing messages by key
      const existingMessages = new Map(
        state.messages.map((m: any) => [`${m.mailboxAddress}:${m.uid}`, m]),
      );

      // Merge: start with all existing, add/update from payload
      const merged = new Map(existingMessages);
      for (const message of payload.messages) {
        const key = `${message.mailboxAddress}:${message.uid}`;
        const existing = existingMessages.get(key);
        const isNew = isInitialSync
          ? false
          : (message.isNew ?? existing?.isNew ?? !existing);
        merged.set(key, {
          id: message.id,
          uid: message.uid,
          mailboxAddress: message.mailboxAddress,
          messageId: message.messageId ?? existing?.messageId,
          subject: message.subject,
          fromName: message.from[0] ?? "Unknown",
          fromAddress: message.from[1] ?? "unknown",
          to: message.to,
          body: message.body,
          date: message.date,
          isRead: message.isRead,
          isNew,
          // Preserve Jazz-only fields from existing entry so a re-fetch doesn't
          // reset snooze or archive state for messages already in the cache.
          ...(existing?.snoozedUntil !== undefined && {
            snoozedUntil: existing.snoozedUntil,
          }),
          ...(existing?.isArchived !== undefined && {
            isArchived: existing.isArchived,
          }),
        });
      }

      state.messages.$jazz.applyDiff([...merged.values()]);

      // Folders and mailboxes: only replace when the payload has data to avoid
      // wiping them on incremental polls that always send empty arrays.
      if (payload.folders.length > 0) {
        state.folders.$jazz.applyDiff(
          payload.folders.map((f) => ({
            id: f.id,
            name: f.name,
            path: f.path,
            unread: f.unread,
            total: f.total,
          })),
        );
      }

      if (payload.mailboxes.length > 0) {
        state.mailboxes.$jazz.applyDiff(
          payload.mailboxes.map((m) => ({
            id: m.id,
            emailAddress: m.emailAddress,
            image: m.image ?? undefined,
          })),
        );
      }

      state.$jazz.set("lastSyncedAt", new Date().toISOString());
    };

    const updateMessageReadStatus = (
      target: Pick<EmailDto, "uid" | "mailboxAddress">,
      isRead: boolean,
    ) => {
      const state = ensureInboxState();
      const message = state.messages.find(
        (entry) =>
          entry.uid === target.uid &&
          entry.mailboxAddress === target.mailboxAddress,
      );

      if (message) {
        message.$jazz.set("isRead", isRead);
        if (isRead) {
          message.$jazz.set("isNew", false);
        }
      }
    };

    const clearMessageNewStatus = (
      target: Pick<EmailDto, "uid" | "mailboxAddress">,
    ) => {
      const state = ensureInboxState();
      const message = state.messages.find(
        (entry) =>
          entry.uid === target.uid &&
          entry.mailboxAddress === target.mailboxAddress,
      );

      if (message) {
        message.$jazz.set("isNew", false);
      }
    };

    const archiveMessage = (
      target: Pick<EmailDto, "uid" | "mailboxAddress">,
    ) => {
      const state = ensureInboxState();
      const msg = state.messages.find(
        (m: any) =>
          m.uid === target.uid && m.mailboxAddress === target.mailboxAddress,
      );
      if (msg) msg.$jazz.set("isArchived", true);
    };

    const snoozeMessage = (
      target: Pick<EmailDto, "uid" | "mailboxAddress">,
      until: string | undefined,
    ) => {
      const state = ensureInboxState();
      const msg = state.messages.find(
        (m: any) =>
          m.uid === target.uid && m.mailboxAddress === target.mailboxAddress,
      );
      if (msg) {
        if (until) {
          msg.$jazz.set("snoozedUntil", until);
          msg.$jazz.set("isNew", false);
        } else {
          // Resurface: clear snooze and mark as new
          msg.$jazz.set("snoozedUntil", undefined);
          msg.$jazz.set("isNew", true);
        }
      }
    };

    const allowSender = (address: string) => {
      const state = ensureInboxState();
      const rules = state.senderRules ?? [];
      const existing = rules.find((r: any) => r.address === address);
      if (existing) {
        existing.$jazz.set("rule", "allow");
      } else {
        rules.$jazz.applyDiff([
          ...rules.map((r: any) => ({ address: r.address, rule: r.rule })),
          { address, rule: "allow" },
        ]);
      }
    };

    const blockSender = (address: string) => {
      const state = ensureInboxState();
      const rules = state.senderRules ?? [];
      const existing = rules.find((r: any) => r.address === address);
      if (existing) {
        existing.$jazz.set("rule", "block");
      } else {
        rules.$jazz.applyDiff([
          ...rules.map((r: any) => ({ address: r.address, rule: r.rule })),
          { address, rule: "block" },
        ]);
      }
    };

    const syncScheduledEmails = (
      emails: Array<{
        id: string;
        to: string;
        subject: string;
        sendAt: string;
      }>,
    ) => {
      const state = ensureInboxState();
      state.scheduledEmails?.$jazz.applyDiff(emails);
    };

    const addRecentSearch = (query: string) => {
      const state = ensureInboxState();
      const searches = state.recentSearches ?? [];
      const now = new Date().toISOString();

      // Remove duplicate if exists
      const filtered = searches
        .map((s: any) => ({ query: s.query, searchedAt: s.searchedAt }))
        .filter((s: any) => s.query !== query);

      // Add new search at the front, keep max 10
      const updated = [{ query, searchedAt: now }, ...filtered].slice(0, 10);
      searches.$jazz.applyDiff(updated);
    };

    const state = ensureInboxState();

    return {
      isLoaded: true,
      messages: mapMessages(state),
      folders: mapFolders(state),
      mailboxes: mapMailboxes(state),
      scheduledEmails: (state.scheduledEmails ?? []).map((e: any) => ({
        id: e.id,
        to: e.to,
        subject: e.subject,
        sendAt: e.sendAt,
      })),
      senderRules: (state.senderRules ?? []).map((r: any) => ({
        address: r.address,
        rule: r.rule as "allow" | "block",
      })),
      recentSearches: (state.recentSearches ?? []).map((s: any) => ({
        query: s.query,
        searchedAt: s.searchedAt,
      })),
      syncInbox,
      updateMessageReadStatus,
      clearMessageNewStatus,
      archiveMessage,
      snoozeMessage,
      allowSender,
      blockSender,
      syncScheduledEmails,
      addRecentSearch,
    };
  }, [me]);

  return (
    <JazzInboxContext.Provider value={contextValue}>
      {children}
    </JazzInboxContext.Provider>
  );
}

export function JazzProvider({ children }: { children: React.ReactNode }) {
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    setupKvStore();
    setIsReady(true);
  }, []);

  if (!isReady) return null;

  return (
    <JazzReactProvider
      AccountSchema={JazzMailAccount}
      sync={getSyncConfig()}
      fallback={null}
      onLogOut={() => authClient.signOut()}
      authSecretStorageKey={JAZZ_AUTH_SECRET_STORAGE_KEY}
    >
      {/* authClient includes magicLinkClient() in its plugins tuple; cast is safe because AuthProvider only consumes the Jazz plugin surface */}
      <AuthProvider betterAuthClient={authClient as unknown as JazzAuthClient}>
        <JazzInboxStateProvider>{children}</JazzInboxStateProvider>
      </AuthProvider>
    </JazzReactProvider>
  );
}

export function useJazzInboxState(): JazzInboxContextValue {
  const context = useContext(JazzInboxContext);

  if (!context) {
    throw new Error("useJazzInboxState must be used within JazzProvider");
  }

  return context;
}
