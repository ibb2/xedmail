import { getGoogleUserInfo, refreshAccessToken } from "@/lib/google-oauth";
import {
  getMailboxByEmail,
  getUserMailboxes,
  updateMailboxTokens,
} from "@/lib/mail-store";
import type { MailboxRecord } from "@/lib/mail-types";

type MailboxAccess = {
  mailbox: MailboxRecord;
  accessToken: string;
};

async function ensureValidMailboxToken(
  mailbox: MailboxRecord,
): Promise<MailboxAccess> {
  const { accessToken, refreshToken } = mailbox;
  const isExpired =
    typeof mailbox.accessTokenExpiresAt === "number" &&
    mailbox.accessTokenExpiresAt <= Date.now() + 15_000;

  if (!isExpired) {
    return { mailbox, accessToken };
  }

  if (!refreshToken) {
    throw new Error("MAILBOX_TOKEN_EXPIRED");
  }

  const refreshed = await refreshAccessToken(refreshToken);

  await updateMailboxTokens(mailbox.id, {
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken ?? refreshToken,
    expiresAt: refreshed.expiresAt,
  });

  return { mailbox, accessToken: refreshed.accessToken };
}

export async function getValidMailboxForUser(
  userId: string,
  emailAddress: string,
): Promise<MailboxAccess> {
  const mailbox = await getMailboxByEmail(userId, emailAddress);

  if (!mailbox) {
    throw new Error("MAILBOX_NOT_FOUND");
  }

  return ensureValidMailboxToken(mailbox);
}

export async function getValidMailboxesForUser(
  userId: string,
): Promise<MailboxAccess[]> {
  const mailboxes = await getUserMailboxes(userId);
  const active = mailboxes.filter((mailbox) => mailbox.isActive);

  return Promise.all(active.map((mailbox) => ensureValidMailboxToken(mailbox)));
}

export async function inferMailboxEmail(accessToken: string): Promise<string> {
  const profile = await getGoogleUserInfo(accessToken);
  return profile.email;
}
