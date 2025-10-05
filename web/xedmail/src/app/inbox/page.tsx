import InboxClient from "@/components/inbox/inbox-client";
import {
  Card,
  CardContent,
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
import { currentUser } from "@clerk/nextjs/server";
import React from "react";

export default async function Inbox({
  query,
  searchParams,
}: {
  query: string;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const user = await currentUser();

  const filters = (await searchParams).q;
  console.log("Filters:", filters);

  const data = await fetch(
    `http://localhost:5172/api/search?email=${user?.emailAddresses?.[0]?.emailAddress}&query=${filters}`,
    {
      credentials: "include", // Critical!
    },
  );
  const emails = await data.json();

  return <InboxClient emails={emails} />;
}
