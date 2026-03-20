import { NextResponse } from "next/server";
import { requireClerkUserId } from "@/lib/api-auth";
import { getUnsentScheduledEmailsForUser } from "@/lib/mail-store";

export const runtime = "nodejs";

export async function GET() {
  try {
    const clerkUserId = await requireClerkUserId();
    const rows = await getUnsentScheduledEmailsForUser(clerkUserId);
    const scheduled = rows.map((row) => ({
      id: row.id,
      to: row.toAddress,
      subject: row.subject,
      sendAt: new Date(row.sendAt).toISOString(),
    }));
    return NextResponse.json({ scheduled });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json(
      { error: "Failed to fetch scheduled emails" },
      { status: 500 },
    );
  }
}
