/** "Alex Morgan <alex@x.com>" -> "alex@x.com" (lowercased). */
export function addressOf(mailbox: string): string {
  const m = /<([^>]+)>/.exec(mailbox);
  return (m ? m[1]! : mailbox).trim().toLowerCase();
}

/** The domain of a mailbox, for Message-IDs. */
export function domainOf(mailbox: string): string {
  return addressOf(mailbox).split("@")[1] ?? "localhost";
}
