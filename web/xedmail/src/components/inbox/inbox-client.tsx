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
}

interface Mailbox {
  id: string;
  emailAddress: string;
  image: string | null;
}

export default function InboxClient({ emails }: { emails: Email[] }) {
  const [selectedEmail, setSelectedEmail] = React.useState<Email | null>(null);
  const [body, setBody] = useState("");
  const { mailboxes, updateMessageReadStatus } = useJazzInboxState();

  const { getToken } = useAuth();

  // Use local state so updates cause a re-render
  const [localEmails, setLocalEmails] = useState(emails);

  const clean = () => {
    if (!body) return "";
    return DOMPurify.sanitize(body);
  };

  const htmlEmailBody = { __html: clean() };

  // Accept the email to toggle and stop event propagation from the button
  const toggleRead = async (email: any) => {
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

    const updatedEmail = { ...email, isRead: !email.isRead };

    // Update the local array (immutable update)
    setLocalEmails((prev) =>
      prev.map((e) => (e.id === email.id ? updatedEmail : e)),
    );
    updateMessageReadStatus(
      {
        uid: email.uid,
        mailboxAddress: email.mailboxAddress,
      },
      updatedEmail.isRead,
    );

    // // Also update selectedEmail if it's the same one currently open
    // if (selectedEmail?.id === email.id) {
    //   setSelectedEmail(updatedEmail);
    // }
  };

  const fetchBody = async (email: any) => {
    const token = await getToken();

    console.log("Email ID: ", email.id);
    console.log("Email UID: ", email.uid);

    const response = await fetch(
      `/api/mail/emails/${email.uid}?mailbox=${encodeURIComponent(email.mailboxAddress)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );

    const res = await response.json();
    const body = res.body;
    console.log("Fetching email body, ", body);
    setBody(body);
    return body;
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
                key={email.id}
                onClick={async () => {
                  console.log("Clicked email");
                  setSelectedEmail(email);
                  await fetchBody(email).then(setBody);
                  console.log("Fetched body");
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
                    <ItemTitle>{email.from[email.from.length - 1]}</ItemTitle>
                  </DialogTrigger>
                  <ItemDescription>{email.subject}</ItemDescription>
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
