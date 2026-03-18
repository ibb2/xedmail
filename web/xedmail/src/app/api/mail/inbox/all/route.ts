import { NextResponse } from "next/server";
import { requireClerkUserId } from "@/lib/api-auth";
import { searchInboxMessages } from "@/lib/imap";
import { getValidMailboxForUser } from "@/lib/mail-auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const email = searchParams.get("email");

  if (!email) {
    return NextResponse.json(
      { error: "email query parameter is required" },
      { status: 400 },
    );
  }

  try {
    const clerkUserId = await requireClerkUserId();
    const mailbox = await getValidMailboxForUser(clerkUserId, email);
    const emails = await searchInboxMessages(
      {
        email: mailbox.mailbox.emailAddress,
        accessToken: mailbox.accessToken,
      },
      { all: true },
      20,
    );

    return NextResponse.json(emails);
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "MAILBOX_NOT_FOUND") {
      return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
    }

    return NextResponse.json(
      { error: "Failed to fetch inbox" },
      { status: 500 },
    );
  }
}
