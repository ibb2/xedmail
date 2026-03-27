import { sqliteTable, text, integer, unique } from "drizzle-orm/sqlite-core";

// --- Schema ---
export const sessionTable = sqliteTable("session", {
  id:        text("id").primaryKey(),
  token:     text("token").notNull(),
  userId:    text("userId").notNull(),
  expiresAt: text("expiresAt").notNull(),
});

// Partial read-only projection — only columns needed by the Elysia IMAP daemon.
// The full schema (provider, image, scopes, etc.) is defined in web/xedmail/src/lib/db.ts.
export const mailboxes = sqliteTable("mailboxes", {
  id:                   text("id").primaryKey(),
  userId:               text("user_id").notNull(),
  emailAddress:         text("email_address").notNull(),
  accessToken:          text("access_token").notNull(),
  refreshToken:         text("refresh_token"),
  accessTokenExpiresAt: integer("access_token_expires_at"),
  isActive:             integer("is_active", { mode: "boolean" }).notNull().default(true),
});

export const userState = sqliteTable("user_state", {
  id:           text("id").primaryKey(),
  userId:       text("user_id").notNull(),
  emailId:      text("email_id").notNull(),
  isArchived:   integer("is_archived", { mode: "boolean" }).notNull().default(false),
  snoozedUntil: integer("snoozed_until"),
  isReplied:    integer("is_replied", { mode: "boolean" }).notNull().default(false),
  createdAt:    integer("created_at").notNull(),
  updatedAt:    integer("updated_at").notNull(),
}, (t) => [unique().on(t.userId, t.emailId)]);

export const senderRules = sqliteTable("sender_rules", {
  id:        text("id").primaryKey(),
  userId:    text("user_id").notNull(),
  address:   text("address").notNull(),
  rule:      text("rule", { enum: ["allow", "block"] }).notNull(),
  createdAt: integer("created_at").notNull(),
}, (t) => [unique().on(t.userId, t.address)]);
