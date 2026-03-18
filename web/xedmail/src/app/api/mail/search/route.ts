import { NextResponse } from "next/server";
import { requireClerkUserId } from "@/lib/api-auth";
import { getFolders, searchInboxMessages } from "@/lib/imap";
import { getValidMailboxesForUser } from "@/lib/mail-auth";
import { buildSearchObject } from "@/lib/mail-query";
import type { EmailDto, FolderDto } from "@/lib/mail-types";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get("query") ?? "";

  try {
    const clerkUserId = await requireClerkUserId();
    const mailboxes = await getValidMailboxesForUser(clerkUserId);

    const emailResults: EmailDto[] = [];
    const folders: FolderDto[] = [];

    for (const mailbox of mailboxes) {
      const auth = {
        email: mailbox.mailbox.emailAddress,
        accessToken: mailbox.accessToken,
      };

      const [emails, mailboxFolders] = await Promise.all([
        searchInboxMessages(auth, buildSearchObject(query), 50),
        getFolders(auth),
      ]);

      emailResults.push(...emails);
      folders.push(...mailboxFolders);
    }

    emailResults.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));

    return NextResponse.json({
      emails: emailResults,
      folders,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    return NextResponse.json(
      { error: "Failed to fetch messages" },
      { status: 500 },
    );
  }
}
