import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/api-auth";
import { getEmailByUid } from "@/lib/imap";
import { getValidMailboxForUser } from "@/lib/mail-auth";

export const runtime = "nodejs";

type Context = {
  params: Promise<{
    uid: string;
  }>;
};

export async function GET(request: Request, context: Context) {
  const { uid } = await context.params;
  const { searchParams } = new URL(request.url);
  const mailboxEmail = searchParams.get("mailbox");

  if (!mailboxEmail) {
    return NextResponse.json(
      { error: "mailbox query parameter is required" },
      { status: 400 },
    );
  }

  try {
    const userId = await requireUserId();
    const mailbox = await getValidMailboxForUser(userId, mailboxEmail);
    const email = await getEmailByUid(
      {
        email: mailbox.mailbox.emailAddress,
        accessToken: mailbox.accessToken,
      },
      uid,
    );

    if (!email) {
      return NextResponse.json({ error: "Email not found" }, { status: 404 });
    }

    return NextResponse.json(email);
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "MAILBOX_NOT_FOUND") {
      return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
    }

    return NextResponse.json(
      { error: "Failed to fetch email" },
      { status: 500 },
    );
  }
}
