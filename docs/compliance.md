# Compliance

Cold outreach is legal in most places when it is honest, identifies you,
targets people in their work role, and stops the moment someone asks. The
details differ by country and change over time. This page is a starting point,
not legal advice: check the rules where your prospects are, with a lawyer if
the stakes are high.

## What cold does for you

- **Identifies the sender.** Email goes from your real address with your name;
  the footer gives a company name and a valid postal address (`postal_address`
  is required before any email sends).
- **Offers an opt-out in every email.** The footer tells people to reply
  "stop" or "unsubscribe", and the `List-Unsubscribe` header gives mail apps an
  unsubscribe button. With `unsubscribe_url` set, the header also supports
  one-click unsubscribe (RFC 8058).
- **Honours it at once, everywhere.** `cold email sync` logs an opt-out the
  next time it reads the inbox, and from then on that person is skipped on
  every channel, by every account. When they came from the dialer, they are set
  to Do Not Contact there too, so they are not called either. An unsubscribe
  from an address you never emailed (a forward or an alias) suppresses that
  address and is flagged, so you can find who it forwards for.
- **Keeps subjects honest.** Lint rejects a subject that pretends to be a
  reply or a forward. Only real follow-ups in a thread start with "Re:".
- **Stops on bounces and invalid addresses**, and never automates DMs.
- **Keeps a record.** Every send, reply, bounce and opt-out is a `coldTouch`
  with a timestamp: what you sent, to whom, and when they said no.

What it cannot do: decide whether you may contact someone in the first place.
That depends on who they are, where they are, and how you got their details.

## Email

**United States (CAN-SPAM).** Covers all commercial email, B2B included. No
consent is needed, but the email must not have false header information or a
misleading subject, must be identifiable as a commercial message, must carry a
valid postal address, and must explain how to opt out. Opt-outs must be honoured
within 10 business days, and you are responsible for anyone sending on your
behalf.

**United Kingdom (PECR and UK GDPR).** You may email employees of companies
("corporate subscribers") without prior consent, as long as you identify
yourself and give a way to opt out. Sole traders and some partnerships count as
individuals and need consent. Their details are still personal data: you need a
lawful basis (usually legitimate interests, with your reasoning written down)
and must tell people where you got their details.

**European Union (GDPR and national ePrivacy laws).** National rules differ.
Some countries allow B2B cold email on legitimate interests; others, Germany
among them, effectively require prior consent even for business addresses.
Check the recipient's country.

**Canada (CASL).** Commercial email needs consent. Implied consent can come
from an address someone has published conspicuously, with no statement
refusing unsolicited messages, when your email is relevant to their role.
Identify yourself, include contact details and an unsubscribe that works for
60 days, and honour it within 10 business days.

**Australia (Spam Act 2003).** Commercial email needs consent, which can be
inferred from a work address that is published conspicuously when the message
relates to the person's role. Identify yourself and honour an unsubscribe
within 5 business days.

## Calls

- **Use a real person.** Pre-recorded and artificial voice calls are tightly
  restricted almost everywhere, and usually need prior consent. The dialer
  connects you live.
- **Screen the list.** US: the National Do Not Call Registry covers consumer
  numbers. Business lines are generally exempt, but many owners give their
  mobile number, and some states add their own rules. UK: screen against TPS
  (people and sole traders) and CTPS (companies). Australia: wash the list
  against the Do Not Call Register. Canada: keep your own do-not-call list even
  for B2B calls.
- **Call at reasonable hours** in the prospect's time zone. The US rule is 8am
  to 9pm; other countries set their own.
- **Say who you are and why you're calling,** and give a number they can reach
  you on (`{{sender_phone}}` in the voicemail scripts).
- **Keep an internal do-not-call list.** That is the dialer's Do Not Contact
  status, and `cold` respects it.

## DMs and platform rules

LinkedIn's User Agreement prohibits bots and other automated ways of sending
messages and invitations. X's rules prohibit bulk, aggressive or unsolicited
automated DMs. Meta's terms prohibit automated access to Instagram and
Facebook. `cold` never sends a DM: it writes it, you send it. Keep the daily
caps human, and when someone says no in a DM, log it (`o` in `cold dm run`, or
`cold log --kind OPTED_OUT`). That stops every channel.

## Data and records

- Keep prospect data to what the outreach needs. The variables in
  `messages/README.md` are the whole list.
- When someone opts out, keep the opt-out record: it is what stops them from
  being contacted again. Deleting it would put them back in the next batch.
- When someone asks what you hold on them or asks you to erase it, look up
  their Twenty record and its Cold Touches. If you erase them, keep a minimal
  opt-out record (the address and the date) if your law allows it, so they are
  never contacted again.
