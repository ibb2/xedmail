// src/lib/mail-compose.ts
// Builds RFC 2822 plain-text messages for the Gmail REST API send endpoint.
// No external library is needed for plain-text-only sends.

export type ComposeOpts = {
  from: string;
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
};

export function buildRfc2822(opts: ComposeOpts): string {
  const date = new Date().toUTCString();
  const lines: string[] = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    `Date: ${date}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
  ];

  if (opts.inReplyTo) lines.push(`In-Reply-To: ${opts.inReplyTo}`);
  if (opts.references) lines.push(`References: ${opts.references}`);

  return `${lines.join("\r\n")}\r\n\r\n${opts.body}`;
}

export function encodeMessage(raw: string): string {
  return Buffer.from(raw).toString("base64url");
}
