import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { currentUser } from "@clerk/nextjs/server";

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

  return (
    <div className="flex flex-col items-center justify-center h-full ">
      <p>Inbox</p>
      <ul className="flex flex-col gap-y-1 w-2/3 max-w-2xl">
        {emails.map((email) => (
          <Card key={email.id} className="">
            <CardHeader>
              <CardTitle>{email.from}</CardTitle>
              <CardDescription>{email.subject}</CardDescription>
            </CardHeader>
          </Card>
        ))}
      </ul>
    </div>
  );
}
