import { NextResponse } from "next/server";
import { buildRfc2822, encodeMessage } from "@/lib/mail-compose";
import { getValidMailboxForUser } from "@/lib/mail-auth";
import {
  claimDueScheduledEmails, clearScheduledEmailLock,
  markScheduledEmailSent, resetStuckScheduledEmails,
} from "@/lib/mail-store";

export const runtime = "nodejs";

const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = Date.now();

  // TTL recovery: reset rows stuck in sending=1 for >5 minutes (crash recovery)
  await resetStuckScheduledEmails(now - 5 * 60 * 1000);

  // Atomically claim rows due now (uses a DB transaction — see mail-store.ts)
  const rows = await claimDueScheduledEmails(now);

  let sent = 0;
  for (const row of rows) {
    try {
      const { mailbox: mailboxRecord, accessToken } = await getValidMailboxForUser(
        row.clerkUserId, row.mailboxAddress,
      );

      const raw = buildRfc2822({
        from: mailboxRecord.emailAddress,
        to: row.toAddress, subject: row.subject, body: row.body,
        inReplyTo: row.inReplyTo ?? undefined,
        references: row.references ?? undefined,
      });

      const response = await fetch(GMAIL_SEND_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ raw: encodeMessage(raw) }),
      });

      if (response.ok) {
        await markScheduledEmailSent(row.id);
        sent++;
      } else {
        await clearScheduledEmailLock(row.id); // retry next tick
      }
    } catch {
      await clearScheduledEmailLock(row.id); // retry next tick
    }
  }

  return NextResponse.json({ sent });
}
