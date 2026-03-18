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
import { useAuth } from "@clerk/nextjs";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "../ui/item";
import { Avatar, AvatarFallback, AvatarImage } from "../ui/avatar";
import { useJazzInboxState } from "@/providers/jazz-provider";
import { cn } from "@/lib/utils";

interface Email {
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
}

interface Mailbox {
  id: string;
  emailAddress: string;
  image: string | null;
}

function getEmailKey(email: Pick<Email, "mailboxAddress" | "uid">) {
  return `${email.mailboxAddress}:${email.uid}`;
}

export default function InboxClient({ emails }: { emails: Email[] }) {
  const [selectedEmail, setSelectedEmail] = React.useState<Email | null>(null);
  const [body, setBody] = useState("");
  const { mailboxes, updateMessageReadStatus, clearMessageNewStatus } = useJazzInboxState();

  const { getToken } = useAuth();

  // Use local state so updates cause a re-render
  const [localEmails, setLocalEmails] = useState(emails);

  const clean = () => {
    if (!body) return "";
    return DOMPurify.sanitize(body);
  };

  const htmlEmailBody = { __html: clean() };

  // Accept the email to toggle and stop event propagation from the button
  const toggleRead = async (email: Email) => {
    if (!email) return;

    const token = await getToken();

    // Optionally send PATCH to server here...
    await fetch(
      `/api/mail/emails/mailbox/${encodeURIComponent(email.mailboxAddress)}/${email.uid}?isRead=${email.isRead}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      },
    );

    const updatedEmail = { ...email, isRead: !email.isRead, isNew: email.isRead ? email.isNew : false };

    // Update the local array (immutable update)
    setLocalEmails((prev) =>
      prev.map((entry) => (getEmailKey(entry) === getEmailKey(email) ? updatedEmail : entry)),
    );
    updateMessageReadStatus(
      {
        uid: email.uid,
        mailboxAddress: email.mailboxAddress,
      },
      updatedEmail.isRead,
    );

    if (!email.isRead) {
      clearMessageNewStatus({
        uid: email.uid,
        mailboxAddress: email.mailboxAddress,
      });
    }

    if (selectedEmail && getEmailKey(selectedEmail) === getEmailKey(email)) {
      setSelectedEmail(updatedEmail);
    }
  };

  const fetchBody = async (email: Email) => {
    const token = await getToken();

    const response = await fetch(
      `/api/mail/emails/${email.uid}?mailbox=${encodeURIComponent(email.mailboxAddress)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );

    if (!response.ok) {
      return "";
    }

    const res = await response.json();
    const nextBody = typeof res.body === "string" ? res.body : "";
    setBody(nextBody);
    return nextBody;
  };

  const getInitials = (name: string) => {
    const words = name.split(" ");

    return words.map((word) => word.charAt(0).toUpperCase()).slice(0, 2);
  };

  // Keep local state in sync if parent prop changes
  useEffect(() => {
    setLocalEmails(emails);
  }, [emails]);

  return (
    <div className="flex flex-col items-center justify-center h-full">
      <p>Inbox</p>
      <Dialog
        onOpenChange={(open) => {
          if (open === false) {
            setBody("");
          }
        }}
      >
        <ul className="flex flex-col gap-y-1 w-2/3 max-w-2xl">
          {localEmails
            .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
            .map((email: Email) => (
              <Item
                variant="outline"
                key={getEmailKey(email)}
                className={cn(
                  "cursor-pointer border transition-colors",
                  email.isNew
                    ? "border-emerald-300 bg-emerald-50/80 shadow-[inset_4px_0_0_0_theme(colors.emerald.500)]"
                    : "border-border bg-background",
                  !email.isRead && !email.isNew && "bg-muted/20",
                )}
                onClick={async () => {
                  setSelectedEmail({ ...email, isNew: false });
                  setLocalEmails((prev) =>
                    prev.map((entry) =>
                      getEmailKey(entry) === getEmailKey(email)
                        ? { ...entry, isNew: false }
                        : entry,
                    ),
                  );
                  clearMessageNewStatus({
                    uid: email.uid,
                    mailboxAddress: email.mailboxAddress,
                  });
                  await fetchBody(email);
                }}
              >
                <ItemMedia>
                  <div className="*:data-[slot=avatar]:ring-background flex -space-x-2 *:data-[slot=avatar]:ring-2">
                    <Avatar className="hidden sm:flex">
                      <AvatarImage
                        src={
                          mailboxes.find(
                            (mailbox) =>
                              mailbox.emailAddress === email.mailboxAddress,
                          )?.image ?? undefined
                        }
                        alt="@shadcn"
                        onError={(e) => {
                          console.log("Error loading image", e);
                        }}
                      />
                      <AvatarFallback>
                        {email.mailboxAddress.charAt(0).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <Avatar className="hidden sm:flex">
                      <AvatarImage src="#" alt="@maxleiter" />
                      <AvatarFallback>
                        {getInitials(email.from[0])}
                      </AvatarFallback>
                    </Avatar>
                    {/*<Avatar>
                    <AvatarImage
                      src="https://github.com/evilrabbit.png"
                      alt="@evilrabbit"
                    />
                    <AvatarFallback>ER</AvatarFallback>
                  </Avatar>*/}
                    {/*<Avatar className="hidden sm:flex">
                    <AvatarImage
                      src="https://github.com/shadcn.png"
                      alt="@shadcn"
                    />
                    <AvatarFallback>CN</AvatarFallback>
                  </Avatar>
                  <Avatar className="hidden sm:flex">
                    <AvatarImage
                      src="https://github.com/maxleiter.png"
                      alt="@maxleiter"
                    />
                    <AvatarFallback>LR</AvatarFallback>
                  </Avatar>
                  <Avatar>
                    <AvatarImage
                      src="https://github.com/evilrabbit.png"
                      alt="@evilrabbit"
                    />
                    <AvatarFallback>ER</AvatarFallback>
                  </Avatar>*/}
                  </div>
                </ItemMedia>
                <ItemContent>
                  <DialogTrigger>
                    <ItemTitle className={cn(email.isNew && "font-semibold text-foreground")}>
                      {email.from[email.from.length - 1]}
                      {email.isNew ? (
                        <span className="rounded-full bg-emerald-600 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-white">
                          New
                        </span>
                      ) : null}
                    </ItemTitle>
                  </DialogTrigger>
                  <ItemDescription className={cn(email.isNew && "text-foreground")}>
                    {email.subject}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  {/*<Button size="sm" variant="outline">
                  Invite
                </Button>*/}
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
                </ItemActions>
              </Item>
            ))}
        </ul>
        <DialogContent
          className="overflow-x-auto w-full max-w-3/5! h-2/3"
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
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
