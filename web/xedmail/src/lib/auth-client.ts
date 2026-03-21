// web/xedmail/src/lib/auth-client.ts
"use client";
import { createAuthClient } from "better-auth/react";
import { magicLinkClient } from "better-auth/client/plugins";
import { jazzPluginClient } from "jazz-tools/better-auth/auth/client";

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_BETTER_AUTH_URL ?? "",
  plugins: [magicLinkClient(), jazzPluginClient()],
});

export const { useSession, signIn, signUp, signOut } = authClient;
