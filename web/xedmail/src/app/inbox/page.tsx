"use client";
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
import { useAuth } from "@clerk/nextjs";
import { currentUser } from "@clerk/nextjs/server";
import { useSearchParams } from "next/navigation";
import React, { useEffect } from "react";

export default function Inbox() {
  const { getToken } = useAuth();

  const [ran, setRan] = React.useState(false);
  const [emails, setEmails] = React.useState([]);

  const searchParams = useSearchParams();
  console.log("searchParams:", searchParams.get("query"));
  console.log(
    "encoded searchParams:",
    encodeURIComponent(searchParams.get("query") || ""),
  );

  const getAllEmails = async () => {
    const token = await getToken();

    const data = await fetch(
      `http://localhost:5172/search?query=${encodeURIComponent(searchParams.get("query")?.trim() || "")}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );

    const emails = await data.json();
    console.log("Email: ", emails[0]);
    return emails;
  };

  React.useEffect(() => {
    if (!ran) {
      getAllEmails().then((emails) => {
        setEmails(emails);
        setRan(true);
      });
    }
  }, [ran]);

  return <InboxClient emails={emails} />;
}
