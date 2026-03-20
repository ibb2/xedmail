export type Contact = { name: string; address: string };

// Accept any object with `from: [string, string]` — compatible with both
// EmailDto (from mail-types) and the local Email interface in inbox-client.
export function extractContacts(messages: Array<{ from: [string, string] }>): Contact[] {
  const freq = new Map<string, { name: string; count: number }>();
  for (const m of messages) {
    const [name, addr] = m.from;
    if (!addr || addr === "unknown") continue;
    const entry = freq.get(addr);
    freq.set(addr, entry ? { name, count: entry.count + 1 } : { name, count: 1 });
  }
  return [...freq.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([address, { name }]) => ({ name, address }));
}
