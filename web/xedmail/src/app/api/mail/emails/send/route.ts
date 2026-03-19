import { NextResponse } from "next/server";
import { requireClerkUserId } from "@/lib/api-auth";
import { buildRfc2822, encodeMessage } from "@/lib/mail-compose";
import { getValidMailboxForUser } from "@/lib/mail-auth";

export const runtime = "nodejs";

const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

export async function POST(request: Request) {
  try {
    const body = await request.json() as {
      mailbox: string; to: string; subject: string; body: string;
      inReplyTo?: string; references?: string;
    };

    const clerkUserId = await requireClerkUserId();
    const { mailbox: mailboxRecord, accessToken } = await getValidMailboxForUser(
      clerkUserId, body.mailbox,
    );

    const raw = buildRfc2822({
      from: mailboxRecord.emailAddress,
      to: body.to, subject: body.subject, body: body.body,
      inReplyTo: body.inReplyTo, references: body.references,
    });

    const response = await fetch(GMAIL_SEND_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw: encodeMessage(raw) }),
    });

    if (response.status === 403) {
      return NextResponse.json({ error: "INSUFFICIENT_SCOPE" });
    }
    if (!response.ok) {
      const text = await response.text();
      return NextResponse.json({ error: `Gmail send failed: ${text}` }, { status: 500 });
    }

    const result = await response.json() as { id: string };
    return NextResponse.json({ messageId: result.id });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "MAILBOX_NOT_FOUND") {
      return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
    }
    return NextResponse.json({ error: "Failed to send message" }, { status: 500 });
  }
}
