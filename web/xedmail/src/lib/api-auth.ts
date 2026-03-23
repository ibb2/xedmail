// web/xedmail/src/lib/api-auth.ts
import { auth } from "@/lib/auth";
import { headers } from "next/headers";

export async function requireUserId(): Promise<string> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.id) {
    throw new Error("UNAUTHORIZED");
  }
  return session.user.id;
}
