import { auth } from "@clerk/nextjs/server";

export async function requireClerkUserId(): Promise<string> {
  const { userId } = await auth();

  if (!userId) {
    throw new Error("UNAUTHORIZED");
  }

  return userId;
}
