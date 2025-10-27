"use client";

import SearchBar from "@/components/search/Search";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@clerk/nextjs";
import Image from "next/image";
import { useRouter } from "next/navigation";

const params = new URLSearchParams({
  client_id:
    "611007919856-g0o1ds7pf4qbh8qef9qul4ofqudp8bqk.apps.googleusercontent.com",
  redirect_uri: "http://localhost:5172/oauth/callback",
  response_type: "code",
  scope: "openid https://mail.google.com/ profile email",
  access_type: "offline",
  prompt: "consent",
});

const GoogleOauthUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

export default function Home() {
  const router = useRouter();

  const { getToken } = useAuth();

  const beginOauthFlow = async () => {
    const token = await getToken();

    fetch("http://localhost:5172/oauth/start", {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }).then(async (response) => {
      if (!response.ok) {
        console.error("Failed to start OAuth flow");
      }

      const data = await response.json();
      console.log("Data :", data["authUrl"]);
      router.push(data["authUrl"]);
    });
  };

  return (
    <div className="font-sans grid grid-rows-[20px_1fr_20px] items-center justify-items-center min-h-screen p-8 pb-20 gap-16 sm:p-20">
      <main className="flex flex-col gap-[32px] row-start-2 items-center sm:items-start min-w-full">
        <div className="items-center flex flex-col text-center min-w-full">
          <div className="flex-row gap-y-4 pb-12">
            <p className="text-5xl font-bold">Welcome Ibrahim.</p>
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
