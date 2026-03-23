import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/api-auth";
import { getUserMailboxes, toMailboxDto } from "@/lib/mail-store";

export const runtime = "nodejs";

export async function GET() {
  try {
    const userId = await requireUserId();
    const mailboxes = await getUserMailboxes(userId);

    return NextResponse.json(mailboxes.map(toMailboxDto));
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    return NextResponse.json(
      { error: "Failed to fetch mailboxes" },
      { status: 500 },
    );
  }
}
