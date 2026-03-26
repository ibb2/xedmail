export const runtime = "nodejs";
import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/api-auth";
import { getValidMailboxesForUser } from "@/lib/mail-auth";

const ELYSIA_URL = process.env.ELYSIA_SERVICE_URL!;
const SERVICE_SECRET = process.env.ELYSIA_SERVICE_SECRET!;

if (!ELYSIA_URL) throw new Error("ELYSIA_SERVICE_URL is not set");

export async function GET(request: Request) {
  try {
    const userId = await requireUserId();
    const { searchParams } = new URL(request.url);
    const q = searchParams.get("q") ?? "";
    const mailboxParam = searchParams.get("mailbox");

    const mailboxes = await getValidMailboxesForUser(userId);
    const targets = mailboxParam
      ? mailboxes.filter(m => m.mailbox.emailAddress === mailboxParam)
      : mailboxes;

    const allEmails = await Promise.all(targets.map(async (m) => {
      try {
        const res = await fetch(
          `${ELYSIA_URL}/search?mailbox=${encodeURIComponent(m.mailbox.emailAddress)}&q=${encodeURIComponent(q)}`,
          { headers: { "x-service-secret": SERVICE_SECRET }, cache: "no-store" }
        );
        if (!res.ok) return [];
        const data = await res.json();
        return data.emails ?? [];
      } catch {
        return [];
      }
    }));

    return NextResponse.json({ emails: allEmails.flat() });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Search failed" }, { status: 500 });
  }
}
