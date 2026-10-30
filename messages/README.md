# The message library

Every cold email, cold DM and cold call script lives here as a plain text file
you can read and edit on GitHub. `bun run lint:messages` checks all of them,
and `cold` refuses to send a message that does not pass.

```
messages/
  email/
    personal/              sent from your own mailbox, written as "I"
      founder-direct/        1-first-touch  2-bump  3-new-angle  4-breakup
      video-first/           1-video  2-bump  3-breakup
      right-person/          1-who-handles-this  2-nudge
    company/               sent from the company mailbox or a rep, written as "we"
      problem-proof/         1-first-touch  2-bump  3-proof  4-breakup
      trigger-event/         1-trigger  2-short  3-close-the-loop
      video-walkthrough/     1-walkthrough  2-bump  3-breakup
      right-person/          1-who-handles-this  2-nudge
  dm/
    personal/              from your own profiles
      linkedin/              1-connection-note  2-after-accept  3-video-offer  4-leave-it
      x/                     1-opener  2-bump
      instagram/             1-opener  2-bump
      facebook/              1-opener  2-bump
    company/               from the brand accounts (LinkedIn: a rep's profile)
      linkedin/              1-connection-note  2-after-accept  3-leave-it
      x/                     1-opener  2-bump
      instagram/             1-opener  2-bump
  call/
    personal/              founder-direct  warm-follow-up  voicemail
    company/               reason-for-the-call  gatekeeper  callback  voicemail
    objections.yaml        11 objections, each with a personal and a company answer
```

## Personal or company

The same offer reads differently depending on who sends it. Pick the voice
from the account, not the prospect.

| | Personal | Company |
|---|---|---|
| Sent from | your own mailbox and profiles | the company mailbox, brand accounts, or a rep |
| Written as | "I" | "we" |
| Signed | first name only | name, title and company |
| Works best for | founders, small teams, warm-ish networks | teams, reps, volume above one person's day |
| Proof | your own story and results | customers, numbers, the team behind it |
| On a call | "I run the company" | "the reason for my call" |

A company LinkedIn page cannot start a conversation, so company LinkedIn DMs
are sent by a rep from their own profile, written in the company voice. A
Facebook Page cannot message someone first either, so Facebook DMs are
personal only.

## How a message file looks

```markdown
---
title: First touch
day: 0
subject: "{question|quick question} about {{company}}"
when: The first email to someone you have a real reason to contact.
---
Hi {{first_name|there}},

{{trigger}}

I'm {{sender_first_name}}. I {{offer}}.

{{proof}}

Worth me sending over a two-minute video of how it would work for {{company}}?

{{sender_first_name}}
```

The path says what it is: `email/<voice>/<sequence>/<step>-<slug>.md`,
`dm/<voice>/<sequence>/<step>-<slug>.md` or `call/<voice>/<slug>.md`.

| Front matter | Applies to | Meaning |
|---|---|---|
| `title` | all | Name shown in lists and in the dialer. Required. |
| `day` | email, dm | Days after step 1 that this step is due. Step 1 is day 0. Required. |
| `subject` | email | Required on step 1. A follow-up with no subject is sent as a reply in the same thread. |
| `platform` | dm | `linkedin`, `x`, `instagram` or `facebook`. Required. |
| `category` | call | The category shown in the dialer (`Introduction`, `Follow-up`, `General`). Required. |
| `when` | all | When to use it. Shown by `cold list` and `cold preview`. |
| `max_chars` | dm | A hard limit on the rendered length. LinkedIn notes: 200. |
| `links` | email | `true` allows links in a first email. |
| `variables` | all | Extra variable names this message uses beyond the list below. |

## Template syntax

| Write | Gets |
|---|---|
| `{{first_name}}` | the value. Sending stops if it is empty. |
| `{{first_name\|there}}` | the value, or "there" when it is empty |
| `{{title\|}}` | the value, or nothing |
| `{Hi\|Hey\|Hello}` | one option, picked per prospect and always the same for that prospect |
| `[day]` | itself. Call scripts only: something you fill in live. Lint stops it reaching an email or DM. |

Call scripts are split by `## Section` headings. When they sync to the dialer,
the headings become capitalised labels and anything the account does not fill
(`{{first_name}}`, `{{company}}`) stays in braces for the rep to read off the
contact.

## Variables

Every message may use these. Each one has to read naturally in the sentence
shapes described, because the messages are written around them.

### The prospect (from Twenty or a CSV)

| Variable | Meaning | Example |
|---|---|---|
| `{{first_name}}` | First name | Dana |
| `{{last_name}}` | Last name | Reyes |
| `{{full_name}}` | First and last name, derived when not given | Dana Reyes |
| `{{title}}` | Job title | Owner |
| `{{company}}` | Their business | Clearview Tint |
| `{{city}}` | City | Austin |
| `{{website}}` | Website host, no https:// or www. | clearviewtint.example |
| `{{email}}` | Email address | dana@clearviewtint.example |
| `{{phone}}` | Phone number | +15125550101 |
| `{{rating}}` | Average review rating | 4.8 |
| `{{review_count}}` | Number of reviews | 212 |
| `{{linkedin_url}}` | Where LinkedIn DMs go | https://www.linkedin.com/in/dana-reyes |
| `{{x_handle}}` | Where X DMs go, no @ | clearviewtint |
| `{{instagram_handle}}` | Where Instagram DMs go, no @ | clearviewtint |
| `{{facebook_url}}` | Where Facebook DMs go | https://www.facebook.com/clearviewtint |
| `{{video_url}}` | A video recorded for them (Cap, Loom) | https://cap.so/s/clearview-tint |
| `{{page_url}}` | A page built for them | https://offer.example/clearview-tint |
| `{{trigger}}` | One full sentence: why them, why now. Specific and true. | Saw you just opened a second bay in Round Rock. |

`{{trigger}}` does the most work. It has no fallback anywhere in the library on
purpose: a cold message without a real reason to send it should not be sent.
In Twenty it comes from the `coldTrigger` field (added by `bun run
twenty:schema`); in a CSV, from a `trigger` column.

### The sender (from the account in cold.yaml)

| Variable | Meaning | Example |
|---|---|---|
| `{{sender_first_name}}` | Signs off personal messages | Alex |
| `{{sender_name}}` | Full name | Alex Morgan |
| `{{sender_title}}` | Job title | Founder |
| `{{sender_company}}` | Company | Brightside Studio |
| `{{sender_phone}}` | A number they can call back | +1 512 555 0142 |
| `{{booking_url}}` | Booking link (Cal.com) | https://cal.com/alex/15min |
| `{{postal_address}}` | Required in every cold email footer | 123 Example St, Austin, TX 78701 |

### The offer (from offers in cold.yaml)

| Variable | Must read as | Example |
|---|---|---|
| `{{audience}}` | "I work with {{audience}}" (plural) | window tint shops |
| `{{offer}}` | "I {{offer}}." / "We {{offer}}." | build booking pages that turn Google reviews into appointments |
| `{{outcome}}` | "so you get {{outcome}}" (no pronouns) | more booked jobs from existing Google reviews |
| `{{pain}}` | "Most {{audience}} I talk to {{pain}}." | miss calls after hours and lose the job to whoever answers |
| `{{proof}}` | One true sentence. Never invent a result. | A tint shop in Dallas booked 14 extra jobs from its page in the first month. |

Any other text field on a Twenty record is also available, in snake_case
(`reviewCount` becomes `{{review_count}}`, a custom `nicheLabel` becomes
`{{niche_label}}`), as is any other CSV column. Declare those under
`variables:` in the message that uses them.

## What lint checks

Errors (the message is not loaded, so it cannot be sent):

- the path, front matter, title, day, platform and category rules above
- template syntax, and variables outside the contract
- a step 1 email without a subject, or a subject starting "Re:" or "Fwd:"
- emojis
- `[placeholders]` in an email or DM
- a rendered DM over its `max_chars` (a LinkedIn connection note over 200)
- sequence steps that skip or repeat a number, or days that do not increase
- a call script with no `## Section` headings

Warnings: links in a first email, an email over about 150 words, a subject over
60 characters or with words spam filters look for, a DM over 600 characters.
Lengths are measured with the example values above.

## Adding your own

Copy the closest file, keep the path pattern, run `bun run lint:messages`,
then `bun run cold preview <id>` to read it with real prospect data. A new
sequence is a new folder; the next step is the next number.
