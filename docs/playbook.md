# The playbook

How to run the library so it gets replies and keeps your mailboxes and
accounts healthy. `cold` enforces the hard limits; this is the judgment around
them.

## Before the first email

1. **Send cold email from its own domain.** A second domain that redirects to
   your site (`trybrightside.com` next to `brightside.com`) keeps cold sending
   from ever touching the reputation of the domain your customers and invoices
   use.
2. **Authenticate it.** SPF, DKIM and DMARC (start DMARC at `p=none`). Gmail and
   Yahoo have required these of bulk senders since February 2024, and
   Outlook.com since May 2025. At cold-email volumes you are not "bulk", but
   unauthenticated mail is filtered hard anyway.
3. **Use real mailboxes.** Google Workspace, Microsoft 365 or another
   established host, connected with an app password. A fresh server IP has no
   reputation to send from.
4. **Warm up.** A new mailbox starts at 5 to 10 emails a day next to normal
   mail, adds about 5 a week, and settles around 30 to 50. `daily_cap` in
   `cold.yaml` is the ceiling, so raise it as the mailbox earns it.
5. **Verify before you send.** Run Reacher (`docker run -p 8080:8080
   reacherhq/backend:latest`) and set `REACHER_URL`; step 1 then skips
   addresses that do not exist. Keep bounces under 2 percent and spam
   complaints near zero. Google asks senders to stay under 0.1 percent and
   never reach 0.3.
6. **Keep it plain.** Plain text, no tracking pixel, no attachments, no link in
   the first email (lint warns), one link at most after that.

## The trigger line

Every message is built around `{{trigger}}`: one sentence on why you are
writing to this person now. It is the only line that cannot be reused, and it
is why the rest can be.

| Works | Does not |
|---|---|
| Saw you just opened a second bay in Round Rock. | I came across your company and was impressed. |
| Your Google listing has 98 reviews, and almost every one mentions how fast the turnaround is. | I hope this email finds you well. |
| Saw the ceramic coating before-and-afters you posted this week. | I noticed you're in the auto industry. |
| Saw you're hiring a second front desk coordinator. | Are you the right person to talk to about growth? |

Where they come from: reviews and the Google listing, a new location, a job
post (the dialer stores `hiringRole` and `jobPostUrl`), a recent post on
Instagram or LinkedIn, a change on their website, the news. Write them into
the `coldTrigger` field in Twenty (on the person, or on the dialer's
prospect), or a `trigger` column in a CSV. A prospect without one is held
back, so the batch tells you who still needs research.

## The offer lines

`audience`, `offer`, `outcome`, `pain` and `proof` are written once per offer in
`cold.yaml` and appear in dozens of sentences. Before sending, read them all in
place:

```bash
bun run cold preview founder-direct
bun run cold preview problem-proof --account company
```

`proof` must be true and specific: a number, a place, a time frame. If you do
not have one yet, use the closest true thing ("We built the first three for
shops in Austin this month.") and replace it when you do.

## Cadence

| Day | Email | LinkedIn | Phone |
|---|---|---|---|
| 0 | step 1 | connection request with note | |
| 1 | | message after they accept | |
| 3 | step 2, the bump | | warm follow-up call, voicemail if no answer |
| 4 | | video offer | |
| 7 | step 3, new angle | | |
| 10 | | leave it there | |
| 14 | step 4, breakup | | |

A large share of replies come from the follow-ups rather than the first
email, so let the sequence finish. Channels can run side by side; within one channel, `cold`
never runs two sequences at once for the same person, and waits 30 days
between them. The warm follow-up call script opens with the email you sent, so
call after step 1 or 2 has gone out.

On X and Instagram, one opener and one bump is the whole sequence. A third
unanswered DM costs more goodwill than it earns.

## Volumes that keep accounts healthy

These are the defaults in `cold.example.yaml`. Start lower on new accounts.

| Channel | Start | Ceiling |
|---|---|---|
| Email, per mailbox | 10 to 20 a day | 30 to 50 a day |
| LinkedIn connection requests | 10 a day | 20 a day, well under the weekly invitation limit |
| X DMs | 10 a day | 30 a day |
| Instagram DMs | 10 a day | 20 a day |

More volume means more mailboxes and more people sending, not more per
account. That is what the company voice is for: several reps, the same
library, one log.

## Personal or company

- **Founders start personal.** "I built this" from a founder's own mailbox gets
  answered more than the same words from a brand. Use `founder-direct` and
  `dm/personal/linkedin`.
- **Hand over in the company voice.** When a rep takes over a segment, switch
  them to `problem-proof` and the company DMs. The prospect history carries
  over, so nobody gets step 1 twice.
- **Never both at once by email.** A prospect in a personal email sequence is
  not started on a company one for 30 days after it, and the reverse.

## Calls

- Work in blocks of an hour or more, with the dialer's queue loaded and the
  scripts synced (`cold call sync`).
- Use the permission opener. Ask one question, listen, and book the meeting
  while they are on the phone.
- Voicemail promises an email, so send it: the warm follow-up email or the
  next step of the sequence.
- "Take me off your list" gets the Do Not Contact disposition, which `cold`
  respects on every channel.

## Measure, then rewrite one thing

```bash
bun run cold stats --days 30
```

Reply rate per message shows where a sequence leaks. Rewrite the weakest step,
change one thing at a time (the subject, the first line, the question), and
give it about 100 sends before judging it. Read the replies too: a reply that
says "stop" counts as an opt-out, but a polite no counts as a reply.

To test two versions properly, copy the sequence folder
(`founder-direct-b`), change the one thing, and send each to half of the list.
Variants written with `{a|b}` keep each prospect's wording stable, but the
stats count by message file, so they are for variety, not for testing.
