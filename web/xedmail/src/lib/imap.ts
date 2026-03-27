import { Readable } from "stream";
import {
  ImapFlow,
  type FetchMessageObject,
  type MessageStructureObject,
  type SearchObject,
} from "imapflow";
import type { EmailDto, FolderDto } from "@/lib/mail-types";

type ImapAuth = {
  email: string;
  accessToken: string;
};

const DEFAULT_IMAP_HOST = process.env.IMAP_HOST ?? "imap.gmail.com";
const DEFAULT_IMAP_PORT = Number(process.env.IMAP_PORT ?? 993);
const DEFAULT_IMAP_SECURE = process.env.IMAP_SECURE !== "false";
const INBOX = process.env.IMAP_INBOX_NAME ?? "INBOX";

function createClient(auth: ImapAuth): ImapFlow {
  return new ImapFlow({
    host: DEFAULT_IMAP_HOST,
    port: DEFAULT_IMAP_PORT,
    secure: DEFAULT_IMAP_SECURE,
    auth: {
      user: auth.email,
      accessToken: auth.accessToken,
    },
    logger: false,
  });
}

export async function withImapClient<T>(
  auth: ImapAuth,
  operation: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  const client = createClient(auth);
  await client.connect();

  try {
    return await operation(client);
  } finally {
    try {
      await client.logout();
    } catch {
      client.close();
    }
  }
}

function addressToTuple(
  address: { name?: string; address?: string } | undefined,
): [string, string] {
  return [address?.name ?? "Unknown", address?.address ?? "unknown"];
}

function messageToEmailDto(
  message: FetchMessageObject,
  mailboxAddress: string,
): EmailDto {
  const envelope = message.envelope;
  const from = addressToTuple(envelope?.from?.[0]);
  const to =
    envelope?.to
      ?.map((entry) => entry.address)
      .filter(Boolean)
      .join(", ") ?? "unknown";
  const id = `${mailboxAddress}:${message.uid}`;
  const date = message.internalDate
    ? new Date(message.internalDate).toISOString()
    : new Date().toISOString();
  const subject = envelope?.subject ?? "(No Subject)";
  const isRead = message.flags?.has("\\Seen") ?? false;

  return {
    id,
    uid: String(message.uid),
    mailboxAddress,
    messageId: envelope?.messageId ?? undefined,
    subject,
    from,
    to,
    date,
    isRead,
  };
}

function selectBodyPart(
  structure: MessageStructureObject | undefined,
): { part: string; contentType: string } | null {
  if (!structure) {
    return null;
  }

  const stack: MessageStructureObject[] = [structure];
  let textPlain: { part: string; contentType: string } | null = null;

  while (stack.length > 0) {
    const current = stack.shift();
    if (!current) {
      continue;
    }

    const type = (current.type ?? "").toLowerCase();
    if (type === "text/html" && current.part) {
      return { part: current.part, contentType: type };
    }
    if (type === "text/plain" && current.part) {
      textPlain = { part: current.part, contentType: type };
    }

    if (current.childNodes) {
      stack.push(...current.childNodes);
    }
  }

  return textPlain;
}

async function readableToString(readable: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

export async function getFolders(auth: ImapAuth): Promise<FolderDto[]> {
  return withImapClient(auth, async (client) => {
    const folders = await client.list();
    const output: FolderDto[] = [];

    for (const folder of folders) {
      try {
        const status = await client.status(folder.path, {
          messages: true,
          unseen: true,
        });
        output.push({
          id: folder.path,
          name: folder.name,
          path: folder.path,
          unread: status.unseen ?? 0,
          total: status.messages ?? 0,
        });
      } catch {
        output.push({
          id: folder.path,
          name: folder.name,
          path: folder.path,
          unread: 0,
          total: 0,
        });
      }
    }

    return output;
  });
}

export async function searchInboxMessages(
  auth: ImapAuth,
  query: SearchObject,
  limit = 20,
): Promise<EmailDto[]> {
  return withImapClient(auth, async (client) => {
    const lock = await client.getMailboxLock(INBOX);

    try {
      const uids = await client.search(query, { uid: true });
      if (!uids || uids.length === 0) {
        return [];
      }

      const sliced = uids.slice(-limit).reverse();
      const messages = await client.fetchAll(
        sliced,
        {
          uid: true,
          envelope: true,
          flags: true,
          internalDate: true,
        },
        { uid: true },
      );

      return messages.map((message) => messageToEmailDto(message, auth.email));
    } finally {
      lock.release();
    }
  });
}

export async function getLatestInboxMessages(
  auth: ImapAuth,
  limit = 20,
): Promise<EmailDto[]> {
  return withImapClient(auth, async (client) => {
    const lock = await client.getMailboxLock(INBOX);

    try {
      const mailbox = client.mailbox;
      const exists = mailbox ? mailbox.exists : 0;
      if (exists === 0) {
        return [];
      }

      const startSequence = Math.max(1, exists - limit + 1);
      const messages = await client.fetchAll(
        `${startSequence}:*`,
        {
          uid: true,
          envelope: true,
          flags: true,
          internalDate: true,
        },
        { uid: false },
      );

      return messages
        .map((message) => messageToEmailDto(message, auth.email))
        .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
        .slice(0, limit);
    } finally {
      lock.release();
    }
  });
}

export async function getEmailByUid(
  auth: ImapAuth,
  uid: string,
): Promise<EmailDto | null> {
  return withImapClient(auth, async (client) => {
    const lock = await client.getMailboxLock(INBOX);

    try {
      const message = await client.fetchOne(
        uid,
        {
          uid: true,
          envelope: true,
          flags: true,
          internalDate: true,
          bodyStructure: true,
          source: true,
        },
        { uid: true },
      );

      if (!message) {
        return null;
      }

      const dto = messageToEmailDto(message, auth.email);
      let body = "";
      const bodyPart = selectBodyPart(message.bodyStructure);

      if (bodyPart?.part) {
        const downloaded = await client.download(uid, bodyPart.part, {
          uid: true,
        });
        body = await readableToString(downloaded.content);
      } else if (message.source) {
        body = message.source.toString("utf8");
      }

      return {
        ...dto,
        body,
      };
    } finally {
      lock.release();
    }
  });
}

export async function setReadStatus(
  auth: ImapAuth,
  uid: string,
  isRead: boolean,
): Promise<void> {
  await withImapClient(auth, async (client) => {
    const lock = await client.getMailboxLock(INBOX);

    try {
      if (isRead) {
        await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
      } else {
        await client.messageFlagsRemove(uid, ["\\Seen"], { uid: true });
      }
    } finally {
      lock.release();
    }
  });
}

export async function archiveEmail(auth: ImapAuth, uid: string): Promise<void> {
  await withImapClient(auth, async (client) => {
    const lock = await client.getMailboxLock(INBOX);
    try {
      await client.messageMove(uid, "[Gmail]/All Mail", { uid: true });
    } finally {
      lock.release();
    }
  });
}
