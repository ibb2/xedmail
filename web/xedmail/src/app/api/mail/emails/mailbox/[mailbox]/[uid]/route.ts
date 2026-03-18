import { NextResponse } from "next/server";
import { requireClerkUserId } from "@/lib/api-auth";
import { setReadStatus } from "@/lib/imap";
import { getValidMailboxForUser } from "@/lib/mail-auth";

export const runtime = "nodejs";

type Context = {
  params: Promise<{
    mailbox: string;
    uid: string;
  }>;
};

export async function PATCH(request: Request, context: Context) {
  const { mailbox, uid } = await context.params;
  const { searchParams } = new URL(request.url);

  const isReadParam = searchParams.get("isRead");
  if (isReadParam === null) {
    return NextResponse.json(
      { error: "isRead query parameter is required" },
      { status: 400 },
    );
  }

  const nextReadState = isReadParam === "true";

  try {
    const clerkUserId = await requireClerkUserId();
    const mailboxData = await getValidMailboxForUser(
      clerkUserId,
      decodeURIComponent(mailbox),
    );

    await setReadStatus(
      {
        email: mailboxData.mailbox.emailAddress,
        accessToken: mailboxData.accessToken,
      },
      uid,
      !nextReadState,
    );

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "MAILBOX_NOT_FOUND") {
      return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
    }

    return NextResponse.json(
      { error: "Failed to update read status" },
      { status: 500 },
    );
  }
}
