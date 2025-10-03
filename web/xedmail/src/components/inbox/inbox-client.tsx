// src/app/inbox/InboxClient.tsx (Client Component)
"use client";

import React, { useState } from "react";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import DOMPurify from "dompurify";

export default function InboxClient({ emails }: { emails: any[] }) {
  const [selectedEmail, setSelectedEmail] = useState<any>(null);

  const clean = () => {
    if (!selectedEmail) return "";
    return DOMPurify.sanitize(selectedEmail.body);
  };
  const htmlEmailBody = { __html: clean() };

  return (
    <div className="flex flex-col items-center justify-center h-full">
      <p>Inbox</p>
      <Dialog>
        <ul className="flex flex-col gap-y-1 w-2/3 max-w-2xl">
          {emails.map((email) => (
            <Card key={email.id} onClick={() => setSelectedEmail(email)}>
              <DialogTrigger asChild>
                <CardHeader>
                  <CardTitle>{email.from}</CardTitle>
                  <CardDescription>{email.subject}</CardDescription>
                </CardHeader>
              </DialogTrigger>
            </Card>
          ))}
        </ul>
        <DialogContent className="overflow-x-auto w-full max-w-3/5! h-2/3">
          <DialogHeader>
            <DialogTitle>{selectedEmail?.subject}</DialogTitle>
            <DialogDescription>
              {selectedEmail?.from} - {selectedEmail?.date}
            </DialogDescription>
            {/** biome-ignore lint/security/noDangerouslySetInnerHtml: <explanation> */}
            <div dangerouslySetInnerHTML={htmlEmailBody}></div>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    </div>
  );
}
