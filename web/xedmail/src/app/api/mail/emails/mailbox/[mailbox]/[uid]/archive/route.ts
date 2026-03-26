export const runtime = "nodejs";
import { requireUserId } from "@/lib/api-auth";
import { getDbClient } from "@/lib/db";
import { NextResponse } from "next/server";
import { randomUUID } from "crypto";

export async function POST(_req: Request, { params }: { params: Promise<{ mailbox: string; uid: string }> }) {
  try {
    const userId = await requireUserId();
    const { mailbox, uid } = await params;
    const emailId = `${mailbox}:${uid}`;
    const now = Date.now();
    const db = getDbClient();
    await db.execute({
      sql: `INSERT INTO user_state (id, user_id, email_id, is_archived, created_at, updated_at)
            VALUES (?, ?, ?, 1, ?, ?)
            ON CONFLICT(user_id, email_id) DO UPDATE SET is_archived = 1, updated_at = excluded.updated_at`,
      args: [randomUUID(), userId, emailId, now, now],
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Failed to archive" }, { status: 500 });
  }
}
