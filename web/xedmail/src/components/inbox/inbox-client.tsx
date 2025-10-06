// src/app/inbox/InboxClient.tsx (Client Component)
"use client";

import React, { useState, useEffect } from "react";
import {
  Card,
  CardAction,
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
import { Button } from "../ui/button";
import { Mail, MailOpen } from "lucide-react";

export default function InboxClient({ emails }: { emails: any[] }) {
  const [selectedEmail, setSelectedEmail] = React.useState<any>(null);

  // Use local state so updates cause a re-render
  const [localEmails, setLocalEmails] = useState(emails);

  // Keep local state in sync if parent prop changes
  useEffect(() => {
    setLocalEmails(emails);
  }, [emails]);

  console.log(localEmails);

  const clean = () => {
    if (!selectedEmail) return "";
    return DOMPurify.sanitize(selectedEmail.body);
  };
  const htmlEmailBody = { __html: clean() };

  // Accept the email to toggle and stop event propagation from the button
  const toggleRead = (email: any) => {
    if (!email) return;

    // Optionally send PATCH to server here...
    fetch(
      `http://localhost:5172/api/emails/${email.uid}?email=${email.to}&isRead=${email.isRead}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
      },
    );

    const updatedEmail = { ...email, isRead: !email.isRead };

    // Update the local array (immutable update)
    setLocalEmails((prev) =>
      prev.map((e) => (e.id === email.id ? updatedEmail : e)),
    );

    // Also update selectedEmail if it's the same one currently open
    if (selectedEmail?.id === email.id) {
      setSelectedEmail(updatedEmail);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center h-full">
      <p>Inbox</p>
      <Dialog>
        <ul className="flex flex-col gap-y-1 w-2/3 max-w-2xl">
          {localEmails.map((email) => (
            <Card key={email.id} onClick={() => setSelectedEmail(email)}>
              <CardHeader>
                <DialogTrigger>
                  <CardTitle>{email.from}</CardTitle>
                </DialogTrigger>
                <CardDescription>{email.subject}</CardDescription>
                <CardAction>
                  {email.isRead && (
                    <Button
                      size="icon"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleRead(email);
                      }}
                    >
                      <MailOpen />
                    </Button>
                  )}
                  {email.isRead === false && (
                    <Button
                      size="icon"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleRead(email);
                      }}
                    >
                      <Mail />
                    </Button>
                  )}
                </CardAction>
              </CardHeader>
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
