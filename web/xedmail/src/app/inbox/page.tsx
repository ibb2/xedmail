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
    <div className="flex-col items-center justify-center h-full w-full">
      <p>Inbox</p>
      <ul>
        {emails.map((email) => (
          <li key={email.id}>
            {email.from} - {email.subject}
          </li>
        ))}
      </ul>
    </div>
  );
}
