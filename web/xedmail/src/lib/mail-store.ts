import { randomUUID } from "crypto";
import type { InValue, Row } from "@libsql/client";
import { ensureDatabaseSchema, getDbClient } from "@/lib/db";
import type { MailboxDto, MailboxRecord, OAuthState, Provider } from "@/lib/mail-types";

type TokenPayload = {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: number | null;
  scopes?: string;
  image?: string | null;
  providerMetadataJson?: string | null;
};

function rowToMailbox(row: Row): MailboxRecord {
  return {
    id: String(row.id),
    clerkUserId: String(row.clerk_user_id),
    provider: String(row.provider) as Provider,
    emailAddress: String(row.email_address),
    image: row.image ? String(row.image) : null,
    accessToken: String(row.access_token),
    refreshToken: row.refresh_token ? String(row.refresh_token) : null,
    accessTokenExpiresAt:
      typeof row.access_token_expires_at === "number"
        ? row.access_token_expires_at
        : row.access_token_expires_at
          ? Number(row.access_token_expires_at)
          : null,
    scopes: String(row.scopes ?? ""),
    isActive: Number(row.is_active ?? 1) === 1,
    lastSyncAt:
      typeof row.last_sync_at === "number"
        ? row.last_sync_at
        : row.last_sync_at
          ? Number(row.last_sync_at)
          : null,
    providerMetadataJson: row.provider_metadata_json
      ? String(row.provider_metadata_json)
      : null,
  };
}

export async function createOAuthState(
  clerkUserId: string,
  provider: Provider,
): Promise<OAuthState> {
  await ensureDatabaseSchema();
  const db = getDbClient();
  const state = randomUUID();
  const createdAt = Date.now();

  await db.execute({
    sql: `
      INSERT INTO oauth_states (state, clerk_user_id, provider, created_at)
      VALUES (?, ?, ?, ?)
    `,
    args: [state, clerkUserId, provider, createdAt],
  });

  return { state, clerkUserId, provider, createdAt };
}

export async function consumeOAuthState(state: string): Promise<OAuthState | null> {
  await ensureDatabaseSchema();
  const db = getDbClient();
  const tx = await db.transaction("write");

  try {
    const result = await tx.execute({
      sql: `
        SELECT state, clerk_user_id, provider, created_at
        FROM oauth_states
        WHERE state = ?
      `,
      args: [state],
    });

    if (result.rows.length === 0) {
      await tx.rollback();
      return null;
    }

    await tx.execute({
      sql: `DELETE FROM oauth_states WHERE state = ?`,
      args: [state],
    });

    await tx.commit();

    const row = result.rows[0];
    return {
      state: String(row.state),
      clerkUserId: String(row.clerk_user_id),
      provider: String(row.provider) as Provider,
      createdAt: Number(row.created_at),
    };
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}

async function ensureUserProfile(clerkUserId: string): Promise<void> {
  const db = getDbClient();
  const now = Date.now();
  await db.execute({
    sql: `
      INSERT INTO user_profiles (clerk_user_id, created_at, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(clerk_user_id) DO UPDATE SET updated_at = excluded.updated_at
    `,
    args: [clerkUserId, now, now],
  });
}

export async function upsertMailbox(
  clerkUserId: string,
  provider: Provider,
  emailAddress: string,
  payload: TokenPayload,
): Promise<void> {
  await ensureDatabaseSchema();
  await ensureUserProfile(clerkUserId);

  const db = getDbClient();
  const now = Date.now();

  const args: InValue[] = [
    randomUUID(),
    clerkUserId,
    provider,
    emailAddress,
    payload.image ?? null,
    payload.accessToken,
    payload.refreshToken ?? null,
    payload.expiresAt ?? null,
    payload.scopes ?? "",
    payload.providerMetadataJson ?? null,
    now,
    now,
  ];

  await db.execute({
    sql: `
      INSERT INTO mailboxes (
        id, clerk_user_id, provider, email_address, image,
        access_token, refresh_token, access_token_expires_at,
        scopes, provider_metadata_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(clerk_user_id, provider, email_address)
      DO UPDATE SET
        image = excluded.image,
        access_token = excluded.access_token,
        refresh_token = COALESCE(excluded.refresh_token, mailboxes.refresh_token),
        access_token_expires_at = excluded.access_token_expires_at,
        scopes = excluded.scopes,
        provider_metadata_json = excluded.provider_metadata_json,
        is_active = 1,
        updated_at = excluded.updated_at
    `,
    args,
  });
}

export async function getUserMailboxes(clerkUserId: string): Promise<MailboxRecord[]> {
  await ensureDatabaseSchema();
  const db = getDbClient();

  const result = await db.execute({
    sql: `
      SELECT *
      FROM mailboxes
      WHERE clerk_user_id = ? AND is_active = 1
      ORDER BY updated_at DESC
    `,
    args: [clerkUserId],
  });

  return result.rows.map(rowToMailbox);
}

export async function getMailboxByEmail(
  clerkUserId: string,
  emailAddress: string,
): Promise<MailboxRecord | null> {
  await ensureDatabaseSchema();
  const db = getDbClient();

  const result = await db.execute({
    sql: `
      SELECT *
      FROM mailboxes
      WHERE clerk_user_id = ? AND email_address = ? AND is_active = 1
      LIMIT 1
    `,
    args: [clerkUserId, emailAddress],
  });

  const row = result.rows[0];
  return row ? rowToMailbox(row) : null;
}

export async function updateMailboxTokens(
  mailboxId: string,
  payload: {
    accessToken: string;
    refreshToken?: string | null;
    expiresAt?: number | null;
  },
): Promise<void> {
  await ensureDatabaseSchema();
  const db = getDbClient();

  await db.execute({
    sql: `
      UPDATE mailboxes
      SET
        access_token = ?,
        refresh_token = COALESCE(?, refresh_token),
        access_token_expires_at = ?,
        updated_at = ?
      WHERE id = ?
    `,
    args: [
      payload.accessToken,
      payload.refreshToken ?? null,
      payload.expiresAt ?? null,
      Date.now(),
      mailboxId,
    ],
  });
}

export function toMailboxDto(mailbox: MailboxRecord): MailboxDto {
  return {
    id: mailbox.id,
    emailAddress: mailbox.emailAddress,
    image: mailbox.image,
  };
}

export type ScheduledEmailRecord = {
  id: string;
  clerkUserId: string;
  mailboxAddress: string;
  toAddress: string;
  subject: string;
  body: string;
  inReplyTo: string | null;
  references: string | null;
  sendAt: number; // unix ms
  sent: boolean;
  sending: boolean;
};

function rowToScheduledEmail(row: Row): ScheduledEmailRecord {
  return {
    id: String(row.id),
    clerkUserId: String(row.clerk_user_id),
    mailboxAddress: String(row.mailbox_address),
    toAddress: String(row.to_address),
    subject: String(row.subject),
    body: String(row.body),
    inReplyTo: row.in_reply_to ? String(row.in_reply_to) : null,
    references: row.references ? String(row.references) : null,
    sendAt: Number(row.send_at),
    sent: Number(row.sent) === 1,
    sending: Number(row.sending) === 1,
  };
}

export async function insertScheduledEmail(opts: {
  id: string;
  clerkUserId: string;
  mailboxAddress: string;
  toAddress: string;
  subject: string;
  body: string;
  inReplyTo?: string | null;
  references?: string | null;
  sendAt: number; // unix ms
}): Promise<void> {
  await ensureDatabaseSchema();
  const db = getDbClient();
  await db.execute({
    sql: `
      INSERT INTO scheduled_emails
        (id, clerk_user_id, mailbox_address, to_address, subject, body,
         in_reply_to, "references", send_at, sent, sending)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
    `,
    args: [
      opts.id, opts.clerkUserId, opts.mailboxAddress, opts.toAddress,
      opts.subject, opts.body,
      opts.inReplyTo ?? null, opts.references ?? null, opts.sendAt,
    ],
  });
}

export async function getUnsentScheduledEmailsForUser(
  clerkUserId: string,
): Promise<ScheduledEmailRecord[]> {
  await ensureDatabaseSchema();
  const db = getDbClient();
  const result = await db.execute({
    sql: `SELECT * FROM scheduled_emails WHERE clerk_user_id = ? AND sent = 0 ORDER BY send_at ASC`,
    args: [clerkUserId],
  });
  return result.rows.map(rowToScheduledEmail);
}

export async function resetStuckScheduledEmails(beforeMs: number): Promise<void> {
  await ensureDatabaseSchema();
  const db = getDbClient();
  await db.execute({
    sql: `UPDATE scheduled_emails SET sending = 0 WHERE sent = 0 AND sending = 1 AND send_at <= ?`,
    args: [beforeMs],
  });
}

export async function claimDueScheduledEmails(
  nowMs: number,
): Promise<ScheduledEmailRecord[]> {
  await ensureDatabaseSchema();
  const db = getDbClient();
  const tx = await db.transaction("write");
  try {
    await tx.execute({
      sql: `UPDATE scheduled_emails SET sending = 1 WHERE sent = 0 AND sending = 0 AND send_at <= ?`,
      args: [nowMs],
    });
    const result = await tx.execute({
      sql: `SELECT * FROM scheduled_emails WHERE sent = 0 AND sending = 1 AND send_at <= ?`,
      args: [nowMs],
    });
    await tx.commit();
    return result.rows.map(rowToScheduledEmail);
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}

export async function markScheduledEmailSent(id: string): Promise<void> {
  await ensureDatabaseSchema();
  const db = getDbClient();
  await db.execute({
    sql: `UPDATE scheduled_emails SET sent = 1, sending = 0 WHERE id = ?`,
    args: [id],
  });
}

export async function clearScheduledEmailLock(id: string): Promise<void> {
  await ensureDatabaseSchema();
  const db = getDbClient();
  await db.execute({
    sql: `UPDATE scheduled_emails SET sending = 0 WHERE id = ?`,
    args: [id],
  });
}
