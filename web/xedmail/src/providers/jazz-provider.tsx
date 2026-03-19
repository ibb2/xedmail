"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useClerk, useUser } from "@clerk/nextjs";
import {
  AuthSecretStorage,
  InMemoryKVStore,
  JazzClerkAuth,
  isClerkCredentials,
  KvStoreContext,
} from "jazz-tools";
import { LocalStorageKVStore } from "jazz-tools/browser";
import {
  JazzReactProvider,
  useAccount,
  useAuthSecretStorage,
  useJazzContextValue,
} from "jazz-tools/react";
import { JazzInboxState, JazzMailAccount } from "@/lib/jazz-schema";
import type { EmailDto, FolderDto, MailboxDto } from "@/lib/mail-types";

type JazzInboxContextValue = {
  messages: EmailDto[];
  folders: FolderDto[];
  mailboxes: MailboxDto[];
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

function hasJazzSyncPeer() {
  const peer = process.env.NEXT_PUBLIC_JAZZ_SYNC_PEER;
  return Boolean(peer && (peer.startsWith("ws://") || peer.startsWith("wss://")));
}

function setupKvStore() {
  KvStoreContext.getInstance().initialize(
    typeof window === "undefined"
      ? new InMemoryKVStore()
      : new LocalStorageKVStore(),
  );
}

async function initializeClerkAuth(clerk: ReturnType<typeof useClerk>) {
  const storage = new AuthSecretStorage(JAZZ_AUTH_SECRET_STORAGE_KEY);
  const allowRemoteAccountRestore = hasJazzSyncPeer();

  if (!allowRemoteAccountRestore) {
    const existingCredentials = await storage.get();
    if (existingCredentials?.provider === "clerk") {
      await storage.clearWithoutNotify();
    }
    return;
  }

  if (isClerkCredentials(clerk.user?.unsafeMetadata)) {
    await JazzClerkAuth.loadClerkAuthData(clerk.user.unsafeMetadata, storage);
  }
}

function RegisterClerkAuth({
  clerk,
  children,
}: {
  clerk: ReturnType<typeof useClerk>;
  children: React.ReactNode;
}) {
  const context = useJazzContextValue();
  const authSecretStorage = useAuthSecretStorage();
  const allowRemoteAccountRestore = hasJazzSyncPeer();

  useEffect(() => {
    if ("guest" in context) {
      throw new Error("Clerk auth is not supported in guest mode");
    }

    const authMethod = new JazzClerkAuth(
      context.authenticate,
      context.logOut,
      authSecretStorage,
    );

    const handleUserChange = async (user: typeof clerk.user | null | undefined) => {
      if (!user) {
        if (authSecretStorage.isAuthenticated) {
          await authSecretStorage.clear();
          await context.logOut();
        }
        return;
      }

      if (authSecretStorage.isAuthenticated) {
        return;
      }

      if (allowRemoteAccountRestore && isClerkCredentials(user.unsafeMetadata)) {
        await authMethod.logIn(
          user as unknown as Parameters<typeof authMethod.logIn>[0],
        );
        return;
      }

      const currentCredentials = await authSecretStorage.get();
      if (currentCredentials) {
        await authMethod.signIn(
          user as unknown as Parameters<typeof authMethod.signIn>[0],
        );
      }
    };

    void handleUserChange(clerk.user);

    return clerk.addListener((event) => {
      void handleUserChange(event.user);
    });
  }, [allowRemoteAccountRestore, authSecretStorage, clerk, context]);

  return children;
}

function JazzInboxStateProvider({ children }: { children: React.ReactNode }) {
  const me = useAccount(JazzMailAccount, {
    resolve: {
      root: {
        inboxState: {
          mailboxes: { $each: true },
          folders: { $each: true },
          messages: { $each: true },
        },
      },
    },
  });

  const contextValue = useMemo<JazzInboxContextValue>(() => {
    if (!me.$isLoaded) {
      return {
        messages: [],
        folders: [],
        mailboxes: [],
        syncInbox: () => undefined,
        updateMessageReadStatus: () => undefined,
        clearMessageNewStatus: () => undefined,
      };
    }

    const owner = me.root.$jazz.owner;

    const ensureInboxState = () => {
      if (me.root.inboxState) {
        return me.root.inboxState;
      }

      const inboxState = JazzInboxState.create(
        {
          mailboxes: [],
          folders: [],
          messages: [],
          lastSyncedAt: new Date().toISOString(),
          senderRules: [],
          scheduledEmails: [],
        },
        { owner },
      );

      me.root.$jazz.set("inboxState", inboxState);
      return inboxState;
    };

    const mapMessages = (state: any): EmailDto[] =>
      state.messages.map((message: any) => ({
        id: message.id,
        uid: message.uid,
        mailboxAddress: message.mailboxAddress,
        subject: message.subject,
        from: [message.fromName, message.fromAddress],
        to: message.to,
        body: message.body,
        date: message.date,
        isRead: message.isRead,
        isNew: message.isNew ?? false,
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
      const existingMessages = new Map(
        state.messages.map((message: any) => [
          `${message.mailboxAddress}:${message.uid}`,
          message,
        ]),
      );
      const isInitialSync = state.messages.length === 0;

      state.messages.$jazz.applyDiff(
        payload.messages.map((message) => {
          const key = `${message.mailboxAddress}:${message.uid}`;
          const existingMessage = existingMessages.get(key);
          const isNew = isInitialSync
            ? false
            : message.isNew ??
              existingMessage?.isNew ??
              !existingMessage;

          return {
            id: message.id,
            uid: message.uid,
            mailboxAddress: message.mailboxAddress,
            subject: message.subject,
            fromName: message.from[0] ?? "Unknown",
            fromAddress: message.from[1] ?? "unknown",
            to: message.to,
            body: message.body,
            date: message.date,
            isRead: message.isRead,
            isNew,
          };
        }),
      );

      state.folders.$jazz.applyDiff(
        payload.folders.map((folder) => ({
          id: folder.id,
          name: folder.name,
          path: folder.path,
          unread: folder.unread,
          total: folder.total,
        })),
      );

      state.mailboxes.$jazz.applyDiff(
        payload.mailboxes.map((mailbox) => ({
          id: mailbox.id,
          emailAddress: mailbox.emailAddress,
          image: mailbox.image ?? undefined,
        })),
      );

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

    const state = ensureInboxState();

    return {
      messages: mapMessages(state),
      folders: mapFolders(state),
      mailboxes: mapMailboxes(state),
      syncInbox,
      updateMessageReadStatus,
      clearMessageNewStatus,
    };
  }, [me]);

  return (
    <JazzInboxContext.Provider value={contextValue}>
      {children}
    </JazzInboxContext.Provider>
  );
}

export function JazzProvider({ children }: { children: React.ReactNode }) {
  const clerk = useClerk();
  const { isLoaded: isUserLoaded, user } = useUser();
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    if (!isUserLoaded) {
      return;
    }

    setupKvStore();

    initializeClerkAuth(clerk).then(() => {
      setIsLoaded(true);
    });
  }, [clerk, isUserLoaded, user?.id, user?.unsafeMetadata]);

  if (!isUserLoaded || !isLoaded) {
    return null;
  }

  return (
    <JazzReactProvider
      AccountSchema={JazzMailAccount}
      sync={getSyncConfig()}
      fallback={null}
      onLogOut={clerk.signOut}
      authSecretStorageKey={JAZZ_AUTH_SECRET_STORAGE_KEY}
    >
      <RegisterClerkAuth clerk={clerk}>
        <JazzInboxStateProvider>{children}</JazzInboxStateProvider>
      </RegisterClerkAuth>
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
