export type Provider = "Gmail";

export type MailboxRecord = {
  id: string;
  clerkUserId: string;
  provider: Provider;
  emailAddress: string;
  image: string | null;
  accessToken: string;
  refreshToken: string | null;
  accessTokenExpiresAt: number | null;
  scopes: string;
  isActive: boolean;
  lastSyncAt: number | null;
  providerMetadataJson: string | null;
};

export type MailboxDto = {
  id: string;
  emailAddress: string;
  image: string | null;
};

export type EmailDto = {
  id: string;
  uid: string;
  mailboxAddress: string;
  subject: string;
  from: [string, string];
  to: string;
  body?: string;
  date: string;
  isRead: boolean;
  isNew?: boolean;
  snoozedUntil?: string;   // new
  isArchived?: boolean;    // new
};

export type OAuthState = {
  state: string;
  clerkUserId: string;
  provider: Provider;
  createdAt: number;
};

export type FolderDto = {
  id: string;
  name: string;
  path: string;
  unread: number;
  total: number;
};
