import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/api-auth";
import { createGoogleAuthUrl } from "@/lib/google-oauth";
import { createOAuthState } from "@/lib/mail-store";

export const runtime = "nodejs";

export async function GET() {
  try {
    const userId = await requireUserId();
    const oauthState = await createOAuthState(userId, "Gmail");
    const authUrl = createGoogleAuthUrl(oauthState.state);

    return NextResponse.json({ authUrl });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    return NextResponse.json(
      { error: "Failed to start OAuth flow" },
      { status: 500 },
    );
  }
}
