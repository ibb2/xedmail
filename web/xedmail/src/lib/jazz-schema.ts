import { co, z } from "jazz-tools";

export const JazzMailbox = co.map({
  id: z.string(),
  emailAddress: z.string(),
  image: z.optional(z.string()),
});

export const JazzFolder = co.map({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  unread: z.number(),
  total: z.number(),
});

export const JazzMessage = co.map({
  id: z.string(),
  uid: z.string(),
  mailboxAddress: z.string(),
  subject: z.string(),
  fromName: z.string(),
  fromAddress: z.string(),
  to: z.string(),
  body: z.optional(z.string()),
  date: z.string(),
  isRead: z.boolean(),
});

export const JazzInboxState = co.map({
  mailboxes: co.list(JazzMailbox),
  folders: co.list(JazzFolder),
  messages: co.list(JazzMessage),
  lastSyncedAt: z.optional(z.string()),
});

export const JazzMailRoot = co.map({
  inboxState: JazzInboxState.optional(),
});

export const JazzMailAccount = co.account({
  profile: co.profile(),
  root: JazzMailRoot,
}).withMigration((account) => {
  if (!account.$jazz.has("root")) {
    const owner = account.$jazz.owner;
    account.$jazz.set(
      "root",
      JazzMailRoot.create(
        {
          inboxState: undefined,
        },
        owner ? { owner } : undefined,
      ),
    );
  }
}).resolved({
  root: {
    inboxState: {
      mailboxes: { $each: true },
      folders: { $each: true },
      messages: { $each: true },
    },
  },
});
