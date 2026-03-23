// web/xedmail/src/lib/auth.ts
import { betterAuth } from "better-auth";
import { getDbClient } from "@/lib/db";
import { LibsqlDialect } from "kysely-libsql";
import { Kysely } from "kysely";
import { magicLink } from "better-auth/plugins";
import { jazzPlugin } from "jazz-tools/better-auth/auth/server";

export const auth = betterAuth({
  database: {
    db: new Kysely({ dialect: new LibsqlDialect({ client: getDbClient() }) }),
    type: "sqlite",
  },
  secret: process.env.BETTER_AUTH_SECRET!,
  baseURL: process.env.BETTER_AUTH_URL!,
  emailAndPassword: { enabled: true },
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    },
  },
  plugins: [
    jazzPlugin(),
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM_EMAIL) {
          console.log(`[magic-link] ${email}: ${url}`);
          return;
        }
        const { Resend } = await import("resend");
        const resend = new Resend(process.env.RESEND_API_KEY);
        await resend.emails.send({
          from: process.env.RESEND_FROM_EMAIL,
          to: email,
          subject: "Sign in to xedmail",
          html: `<p><a href="${url}">Click here to sign in</a></p>`,
        });
      },
    }),
  ],
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          const now = Date.now();
          try {
            await getDbClient().execute({
              sql: `INSERT INTO user_profiles (user_id, created_at, updated_at)
                    VALUES (?, ?, ?)
                    ON CONFLICT(user_id) DO UPDATE SET updated_at = excluded.updated_at`,
              args: [user.id, now, now],
            });
          } catch (err) {
            console.error("[auth] Failed to upsert user_profiles for", user.id, err);
          }
        },
      },
    },
  },
});

export type Session = typeof auth.$Infer.Session;
