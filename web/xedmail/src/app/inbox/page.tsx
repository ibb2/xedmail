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

export default async function Inbox() {
  const user = await currentUser();

  const data = await fetch(
    `http://localhost:5172/api/inbox/all?email=${user?.emailAddresses?.[0]?.emailAddress}`,
    {
      credentials: "include", // Critical!
    },
  );
  console.log(data);
  const emails = await data.json();
  console.log("Emails", emails);

  return <InboxClient emails={emails} />;
}
