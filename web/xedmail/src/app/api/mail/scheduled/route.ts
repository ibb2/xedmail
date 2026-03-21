import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/api-auth";
import { getUnsentScheduledEmailsForUser } from "@/lib/mail-store";

export const runtime = "nodejs";

export async function GET() {
  try {
    const userId = await requireUserId();
    const rows = await getUnsentScheduledEmailsForUser(userId);
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
