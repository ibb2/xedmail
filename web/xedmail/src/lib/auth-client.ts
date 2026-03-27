// web/xedmail/src/lib/auth-client.ts
"use client";
import { createAuthClient } from "better-auth/client";
import { useStore } from "better-auth/react";
import { magicLinkClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_BETTER_AUTH_URL,
  plugins: [magicLinkClient()],
});

export const { signIn, signUp, signOut } = authClient;

// React hook — converts the nanostores session atom to React state
export function useSession() {
  return useStore(authClient.useSession);
}
