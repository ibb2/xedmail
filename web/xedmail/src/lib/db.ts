import { createClient, type Client } from "@libsql/client";

let client: Client | null = null;
let initialized = false;

function requireEnv(name: "TURSO_DATABASE_URL" | "TURSO_AUTH_TOKEN"): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }

  return value;
}

export function getDbClient(): Client {
  if (client) {
    return client;
  }

  client = createClient({
    url: requireEnv("TURSO_DATABASE_URL"),
    authToken: requireEnv("TURSO_AUTH_TOKEN"),
  });

  return client;
}

export async function ensureDatabaseSchema(): Promise<void> {
  if (initialized) {
    return;
  }

  const db = getDbClient();

  await db.batch(
    [
      `
      CREATE TABLE IF NOT EXISTS user_profiles (
        clerk_user_id TEXT PRIMARY KEY,
        display_name TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      `,
      `
      CREATE TABLE IF NOT EXISTS mailboxes (
        id TEXT PRIMARY KEY,
        clerk_user_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        email_address TEXT NOT NULL,
        image TEXT,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        access_token_expires_at INTEGER,
        scopes TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        last_sync_at INTEGER,
        provider_metadata_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(clerk_user_id, provider, email_address),
        FOREIGN KEY (clerk_user_id) REFERENCES user_profiles(clerk_user_id)
      );
      `,
      `
      CREATE TABLE IF NOT EXISTS oauth_states (
        state TEXT PRIMARY KEY,
        clerk_user_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      `,
      `
      CREATE TABLE IF NOT EXISTS scheduled_emails (
        id TEXT PRIMARY KEY,
        clerk_user_id TEXT NOT NULL,
        mailbox_address TEXT NOT NULL,
        to_address TEXT NOT NULL,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        in_reply_to TEXT,
        references TEXT,
        send_at INTEGER NOT NULL,
        sent INTEGER NOT NULL DEFAULT 0,
        sending INTEGER NOT NULL DEFAULT 0
      );
      `,
    ],
    "write",
  );

  initialized = true;
}
