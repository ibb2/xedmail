import nodemailer from "nodemailer";

export type SendOpts = {
  from: string;
  to: string;
  subject: string;
  body: string;
  accessToken: string;
  inReplyTo?: string;
  references?: string;
};

export async function sendMail(opts: SendOpts): Promise<string> {
  const transport = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: {
      type: "OAuth2",
      user: opts.from,
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      accessToken: opts.accessToken,
    },
  });

  const info = await transport.sendMail({
    from: opts.from,
    to: opts.to,
    subject: opts.subject,
    text: opts.body,
    ...(opts.inReplyTo && {
      inReplyTo: opts.inReplyTo,
      references: opts.references ?? opts.inReplyTo,
    }),
  });

  return info.messageId;
}
