export default async function Inbox() {
  const data = await fetch("http://localhost:5172/api/inbox/all");
  console.log(data);
  const emails = await data.json();
  console.log("Emails", emails);

  return (
    <div className="flex items-center justify-center h-full w-full">
      <p>Inbox</p>
      <ul>
        {emails.map((email) => (
          <li key={email.id}>{email.sender}</li>
        ))}
      </ul>
    </div>
  );
}
