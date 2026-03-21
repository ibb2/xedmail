import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/api-auth";
import { archiveEmail } from "@/lib/imap";
import { getValidMailboxForUser } from "@/lib/mail-auth";

export const runtime = "nodejs";

type Context = {
  params: Promise<{ mailbox: string; uid: string }>;
};

export async function POST(_request: Request, context: Context) {
  const { mailbox, uid } = await context.params;
  const decodedMailbox = decodeURIComponent(mailbox);

  try {
    const userId = await requireUserId();
    const { mailbox: mailboxRecord, accessToken } =
      await getValidMailboxForUser(userId, decodedMailbox);

    const imapHost = process.env.IMAP_HOST ?? "imap.gmail.com";
    if (imapHost !== "imap.gmail.com") {
      return NextResponse.json(
        { error: "Unsupported provider" },
        { status: 400 },
      );
    }

    await archiveEmail({ email: mailboxRecord.emailAddress, accessToken }, uid);

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "MAILBOX_NOT_FOUND") {
      return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
    }
    return NextResponse.json(
      { error: "Failed to archive message" },
      { status: 500 },
    );
  }
}
