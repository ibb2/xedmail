export const runtime = "nodejs";
import { requireUserId } from "@/lib/api-auth";
import { getDbClient } from "@/lib/db";
import { NextResponse } from "next/server";
import { randomUUID } from "crypto";

export async function POST(req: Request, { params }: { params: Promise<{ mailbox: string; uid: string }> }) {
  try {
    const userId = await requireUserId();
    const { mailbox, uid } = await params;
    const emailId = `${mailbox}:${uid}`;
    const { until } = await req.json() as { until?: string };
    const snoozedUntil = until ? new Date(until).getTime() : null;
    const now = Date.now();
    const db = getDbClient();
    await db.execute({
      sql: `INSERT INTO user_state (id, user_id, email_id, snoozed_until, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, email_id) DO UPDATE SET snoozed_until = excluded.snoozed_until, updated_at = excluded.updated_at`,
      args: [randomUUID(), userId, emailId, snoozedUntil, now, now],
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Failed to snooze" }, { status: 500 });
  }
}
