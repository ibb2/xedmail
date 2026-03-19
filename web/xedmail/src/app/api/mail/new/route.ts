import { NextResponse } from "next/server";
import { requireClerkUserId } from "@/lib/api-auth";
import { withImapClient } from "@/lib/imap";
import { getValidMailboxForUser } from "@/lib/mail-auth";
import type { EmailDto } from "@/lib/mail-types";

export const runtime = "nodejs";

const INBOX = process.env.IMAP_INBOX_NAME ?? "INBOX";
const LIMIT = 50;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const minUidParam = searchParams.get("minUid");
  const mailbox = searchParams.get("mailbox");

  if (!mailbox || minUidParam === null) {
    return NextResponse.json(
      { error: "minUid and mailbox are required" },
      { status: 400 },
    );
  }

  const minUid = parseInt(minUidParam, 10);
  if (Number.isNaN(minUid)) {
    return NextResponse.json(
      { error: "minUid must be an integer" },
      { status: 400 },
    );
  }

  try {
    const clerkUserId = await requireClerkUserId();
    const { mailbox: mailboxRecord, accessToken } =
      await getValidMailboxForUser(clerkUserId, decodeURIComponent(mailbox));

    const emails: EmailDto[] = await withImapClient(
      { email: mailboxRecord.emailAddress, accessToken },
      async (client) => {
        const lock = await client.getMailboxLock(INBOX);
        const results: EmailDto[] = [];
        try {
          for await (const msg of client.fetch(
            `${minUid + 1}:*`,
            { uid: true, envelope: true, flags: true, internalDate: true },
            { uid: true },
          )) {
            const envelope = msg.envelope;
            const from = envelope?.from?.[0];
            const to =
              envelope?.to
                ?.map((e: { address?: string }) => e.address)
                .filter(Boolean)
                .join(", ") ?? "unknown";
            const date = msg.internalDate
              ? new Date(msg.internalDate).toISOString()
              : new Date().toISOString();

            results.push({
              id: `${mailboxRecord.emailAddress}:${msg.uid}`,
              uid: String(msg.uid),
              mailboxAddress: mailboxRecord.emailAddress,
              subject: envelope?.subject ?? "(No Subject)",
              from: [from?.name ?? "Unknown", from?.address ?? "unknown"],
              to,
              date,
              isRead: msg.flags?.has("\\Seen") ?? false,
            });

            if (results.length >= LIMIT) break;
          }
        } finally {
          lock.release();
        }
        return results;
      },
    );

    return NextResponse.json({ emails });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "MAILBOX_NOT_FOUND") {
      return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
    }
    return NextResponse.json(
      { error: "Failed to fetch new messages" },
      { status: 500 },
    );
  }
}
