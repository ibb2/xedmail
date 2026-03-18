"use client";

import SearchBar from "@/components/search/Search";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemHeader,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { useAuth } from "@clerk/nextjs";
import { Plus, X } from "lucide-react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import React, { useEffect } from "react";
import { useJazzInboxState } from "@/providers/jazz-provider";

export default function Home() {
  const router = useRouter();
  const { mailboxes, messages, folders, syncInbox } = useJazzInboxState();

  // States
  const [ran, setRan] = React.useState(false);

  const { getToken } = useAuth();

  const beginOauthFlow = async () => {
    const token = await getToken();

    fetch("/api/mail/oauth/start", {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }).then(async (response) => {
      if (!response.ok) {
        console.error("Failed to start OAuth flow");
      }

      const data = await response.json();
      router.push(data["authUrl"]);
    });
  };

  const getMailboxes = async () => {
    const token = await getToken();

    const response = await fetch("/api/mail/mailboxes", {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    const nextMailboxes = await response.json();
    syncInbox({
      messages,
      folders,
      mailboxes: nextMailboxes,
    });
  };

  useEffect(() => {
    if (!ran) {
      getMailboxes();
      setRan(true);
    }
  }, [ran]);

  return (
    <div className="font-sans grid grid-rows-[20px_1fr_20px] items-center justify-items-center min-h-screen p-8 pb-20 gap-16 sm:p-20">
      <main className="flex flex-col gap-[32px] row-start-2 items-center sm:items-start min-w-full">
        <div className="items-center flex flex-col text-center min-w-full">
          <div className="flex-row gap-y-4 pb-12">
            <p className="text-5xl font-bold">Welcome Ibrahim.</p>
            <div className="flex mb-8">
              {mailboxes.map(
                (mailbox: {
                  id: string;
                  emailAddress: string;
                  image: string | null;
                }) => (
                  <Item key={mailbox.id} variant={"outline"} size={"sm"}>
                    <ItemMedia>
                      <Avatar className="size-10">
                        <AvatarImage src={mailbox.image ?? undefined} />
                        <AvatarFallback>
                          {mailbox.emailAddress[0].toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                    </ItemMedia>
                    <ItemContent className="flex items-start">
                      <ItemTitle>GMAIL</ItemTitle>
                      <ItemDescription>{mailbox.emailAddress}</ItemDescription>
                    </ItemContent>
                    {/*<ItemActions>
                      <Button
                        size="icon-sm"
                        variant="outline"
                        className="rounded-full"
                        aria-label="Invite"
                      >
                        <X />
                      </Button>
                    </ItemActions>*/}
                  </Item>
                ),
              )}
            </div>
            <div className="flex">
              <Button onClick={() => beginOauthFlow()}>Connect to GMAIL</Button>
            </div>
          </div>
          {/* TODO: Add rows of quick actions like new emails, total emails, etc. */}
          <SearchBar />
        </div>
      </main>
      <footer className="row-start-3 flex gap-[24px] flex-wrap items-center justify-center">
        <a
          className="flex items-center gap-2 hover:underline hover:underline-offset-4"
          href="https://nextjs.org/learn?utm_source=create-next-app&utm_medium=appdir-template-tw&utm_campaign=create-next-app"
          target="_blank"
          rel="noopener noreferrer"
        >
          <Image
            aria-hidden
            src="/file.svg"
            alt="File icon"
            width={16}
            height={16}
          />
          Learn
        </a>
        <a
          className="flex items-center gap-2 hover:underline hover:underline-offset-4"
          href="https://vercel.com/templates?framework=next.js&utm_source=create-next-app&utm_medium=appdir-template-tw&utm_campaign=create-next-app"
          target="_blank"
          rel="noopener noreferrer"
        >
          <Image
            aria-hidden
            src="/window.svg"
            alt="Window icon"
            width={16}
            height={16}
          />
          Examples
        </a>
        <a
          className="flex items-center gap-2 hover:underline hover:underline-offset-4"
          href="https://nextjs.org?utm_source=create-next-app&utm_medium=appdir-template-tw&utm_campaign=create-next-app"
          target="_blank"
          rel="noopener noreferrer"
        >
          <Image
            aria-hidden
            src="/globe.svg"
            alt="Globe icon"
            width={16}
            height={16}
          />
          Go to nextjs.org →
        </a>
      </footer>
    </div>
  );
}
