import { NextResponse } from "next/server";
import { requireClerkUserId } from "@/lib/api-auth";
import { getValidMailboxForUser } from "@/lib/mail-auth";
import { sendMail } from "@/lib/mail-send";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      mailbox: string;
      to: string;
      subject: string;
      body: string;
      inReplyTo?: string;
      references?: string;
    };

    const clerkUserId = await requireClerkUserId();
    const { mailbox: mailboxRecord, accessToken } =
      await getValidMailboxForUser(clerkUserId, body.mailbox);

    const messageId = await sendMail({
      from: mailboxRecord.emailAddress,
      to: body.to,
      subject: body.subject,
      body: body.body,
      accessToken,
      inReplyTo: body.inReplyTo,
      references: body.references,
    });

    return NextResponse.json({ messageId });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "MAILBOX_NOT_FOUND") {
      return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
    }
    const message =
      error instanceof Error ? error.message : "Failed to send message";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
