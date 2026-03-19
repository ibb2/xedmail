import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { requireClerkUserId } from "@/lib/api-auth";
import { getValidMailboxForUser } from "@/lib/mail-auth";
import { insertScheduledEmail } from "@/lib/mail-store";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json() as {
      mailbox: string; to: string; subject: string; body: string;
      inReplyTo?: string; references?: string; sendAt: string;
    };

    const clerkUserId = await requireClerkUserId();
    const { mailbox: mailboxRecord } = await getValidMailboxForUser(clerkUserId, body.mailbox);

    const id = randomUUID();
    await insertScheduledEmail({
      id, clerkUserId,
      mailboxAddress: mailboxRecord.emailAddress,
      toAddress: body.to, subject: body.subject, body: body.body,
      inReplyTo: body.inReplyTo ?? null, references: body.references ?? null,
      sendAt: Date.parse(body.sendAt), // ISO string → unix ms
    });

    return NextResponse.json({ id }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "MAILBOX_NOT_FOUND") {
      return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
    }
    return NextResponse.json({ error: "Failed to schedule message" }, { status: 500 });
  }
}
