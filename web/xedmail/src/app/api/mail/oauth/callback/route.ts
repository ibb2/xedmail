import { NextResponse } from "next/server";
import { exchangeCodeForTokens, getGoogleUserInfo } from "@/lib/google-oauth";
import { consumeOAuthState, upsertMailbox } from "@/lib/mail-store";

export const runtime = "nodejs";

function getAppUrl(): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.APP_URL ??
    "http://localhost:3000"
  );
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");

  if (!state || !code) {
    return NextResponse.json(
      { error: "Missing OAuth state or authorization code" },
      { status: 400 },
    );
  }

  try {
    const oauthState = await consumeOAuthState(state);

    if (!oauthState) {
      return NextResponse.json(
        { error: "Invalid or expired OAuth state" },
        { status: 400 },
      );
    }

    const tokenData = await exchangeCodeForTokens(code);
    const profile = await getGoogleUserInfo(tokenData.accessToken);

    await upsertMailbox(oauthState.clerkUserId, "Gmail", profile.email, {
      accessToken: tokenData.accessToken,
      refreshToken: tokenData.refreshToken,
      expiresAt: tokenData.expiresAt,
      scopes: tokenData.scope,
      image: profile.image,
      providerMetadataJson: JSON.stringify({ provider: "gmail" }),
    });

    return NextResponse.redirect(new URL("/", getAppUrl()));
  } catch {
    return NextResponse.json(
      { error: "OAuth callback failed" },
      { status: 500 },
    );
  }
}
