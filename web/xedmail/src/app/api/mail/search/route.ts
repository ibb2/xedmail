import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/api-auth";
import { getFolders, getLatestInboxMessages, searchInboxMessages } from "@/lib/imap";
import { getValidMailboxesForUser } from "@/lib/mail-auth";
import { buildSearchObject } from "@/lib/mail-query";
import type { EmailDto, FolderDto } from "@/lib/mail-types";

export const runtime = "nodejs";

const MESSAGE_LIMIT = 20;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get("query") ?? "";
  const includeFolders = searchParams.get("includeFolders") !== "false";

  try {
    const userId = await requireUserId();
    const mailboxes = await getValidMailboxesForUser(userId);
    const searchObject = query.trim()
      ? await buildSearchObject(query)
      : null;

    const emailResults: EmailDto[] = [];
    const folders: FolderDto[] = [];

    for (const mailbox of mailboxes) {
      const auth = {
        email: mailbox.mailbox.emailAddress,
        accessToken: mailbox.accessToken,
      };

      const [emails, mailboxFolders] = await Promise.all([
        searchObject
          ? searchInboxMessages(auth, searchObject, MESSAGE_LIMIT)
          : getLatestInboxMessages(auth, MESSAGE_LIMIT),
        includeFolders ? getFolders(auth) : Promise.resolve([]),
      ]);

      emailResults.push(...emails);
      folders.push(...mailboxFolders);
    }

    emailResults.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));

    return NextResponse.json({
      emails: emailResults.slice(0, MESSAGE_LIMIT),
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
