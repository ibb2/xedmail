import { NextResponse } from "next/server";
import { getValidMailboxForUser } from "@/lib/mail-auth";
import { sendMail } from "@/lib/mail-send";
import {
  claimDueScheduledEmails,
  clearScheduledEmailLock,
  markScheduledEmailSent,
  resetStuckScheduledEmails,
} from "@/lib/mail-store";

export const runtime = "nodejs";

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
      const { mailbox: mailboxRecord, accessToken } =
        await getValidMailboxForUser(row.clerkUserId, row.mailboxAddress);

      await sendMail({
        from: mailboxRecord.emailAddress,
        to: row.toAddress,
        subject: row.subject,
        body: row.body,
        accessToken,
        inReplyTo: row.inReplyTo ?? undefined,
        references: row.references ?? undefined,
      });

      await markScheduledEmailSent(row.id);
      sent++;
    } catch {
      await clearScheduledEmailLock(row.id); // retry next tick
    }
  }

  return NextResponse.json({ sent });
}
