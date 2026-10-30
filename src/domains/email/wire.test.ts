import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import nodemailer from "nodemailer";
import { SMTPServer } from "smtp-server";
import type { Touch } from "../touches";
import { buildEmail, classifyInbound } from "./helpers";
import { parseMailboxMessage } from "./sync";

/**
 * The email path on the wire: a draft from buildEmail through a real
 * nodemailer SMTP transport to a local SMTP server, then parsed back the way
 * the reply sync parses a mailbox. Catches anything nodemailer or mailparser
 * do differently from what the unit tests assume.
 */
describe("SMTP round trip", () => {
  const received: string[] = [];
  let server: SMTPServer;
  let port = 0;

  beforeAll(async () => {
    server = new SMTPServer({
      authOptional: true,
      disabledCommands: ["STARTTLS", "AUTH"],
      logger: false,
      onData(stream, _session, callback) {
        const chunks: Buffer[] = [];
        stream.on("data", (c: Buffer) => chunks.push(c));
        stream.on("end", () => {
          received.push(Buffer.concat(chunks).toString("utf8"));
          callback();
        });
      },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    port = (server.server.address() as AddressInfo).port;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  test("a threaded follow-up keeps its Message-ID, threading and unsubscribe headers", async () => {
    const first: Touch = {
      kind: "SENT",
      channel: "EMAIL",
      prospectKey: "email:dana@clearviewtint.example",
      subject: "quick question about Clearview Tint",
      body: "Hi Dana,\n\nSaw the new bay.\n\nAlex",
      messageId: "<first-1@brightside.example>",
      fromAddress: "alex@brightside.example",
      occurredAt: "2026-11-02T15:00:00.000Z",
    };
    const draft = buildEmail({
      from: "Alex Morgan <alex@brightside.example>",
      to: "dana@clearviewtint.example",
      body: "Hi Dana, floating this back up.",
      footer: '123 Example St, Austin, TX 78701\nNot for you? Reply "stop" and I won\'t email you again.',
      first,
      previous: first,
      messageId: "<second-2@brightside.example>",
      unsubscribeUrl: "https://brightside.example/u?e=dana%40clearviewtint.example",
    });
    const transport = nodemailer.createTransport(`smtp://127.0.0.1:${port}`);
    await transport.sendMail(draft);
    transport.close();

    const raw = received.at(-1)!;
    const parsed = await parseMailboxMessage(raw);
    expect(parsed.messageId).toBe("<second-2@brightside.example>");
    expect(parsed.inReplyTo).toBe("<first-1@brightside.example>");
    expect(parsed.references).toEqual(["<first-1@brightside.example>"]);
    expect(parsed.email.subject).toBe("Re: quick question about Clearview Tint");
    // mailparser folds List-* into one structured header, so check the wire itself.
    expect(raw).toMatch(/^List-Unsubscribe: <mailto:alex@brightside\.example\?subject=unsubscribe>,\s+<https:\/\/brightside\.example\/u\?e=dana%40clearviewtint\.example>/m);
    expect(raw).toMatch(/^List-Unsubscribe-Post: List-Unsubscribe=One-Click\r?$/m);
    expect(parsed.email.text).toContain("floating this back up");
    expect(parsed.email.text).toContain("> Saw the new bay.");
    expect(raw).not.toMatch(/Content-Type: text\/html/i);
  });
});

describe("raw inbound mail", () => {
  test("a reply threads back to the email it answers", async () => {
    const message = await parseMailboxMessage(
      [
        "From: Dana Reyes <Dana@ClearviewTint.example>",
        "To: alex@brightside.example",
        "Subject: Re: quick question about Clearview Tint",
        "Message-ID: <reply-1@clearviewtint.example>",
        "In-Reply-To: <first-1@brightside.example>",
        "References: <first-1@brightside.example>",
        "Date: Tue, 03 Nov 2026 10:00:00 -0600",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Sure, send the video over.",
        "",
        "On Mon, Nov 2, 2026, alex@brightside.example wrote:",
        '> Not for you? Reply "stop" and I won\'t email you again.',
      ].join("\r\n"),
    );
    expect(message.from).toBe("dana@clearviewtint.example");
    expect(message.inReplyTo).toBe("<first-1@brightside.example>");
    expect(classifyInbound(message.email).kind).toBe("REPLIED");
  });

  test("a Gmail-style delivery failure is a bounce for the right address", async () => {
    const message = await parseMailboxMessage(
      [
        "From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
        "To: alex@brightside.example",
        "Subject: Delivery Status Notification (Failure)",
        "Message-ID: <dsn-1@mail.gmail.com>",
        "MIME-Version: 1.0",
        'Content-Type: multipart/report; report-type=delivery-status; boundary="b1"',
        "",
        "--b1",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Address not found. Your message wasn't delivered to marcus@hillcountrybody.example.",
        "",
        "--b1",
        "Content-Type: message/delivery-status",
        "",
        "Reporting-MTA: dns; googlemail.com",
        "",
        "Final-Recipient: rfc822; marcus@hillcountrybody.example",
        "Action: failed",
        "Status: 5.1.1",
        "",
        "--b1--",
      ].join("\r\n"),
    );
    expect(message.email.headers["content-type"]).toContain("multipart/report");
    const verdict = classifyInbound(message.email);
    expect(verdict.kind).toBe("BOUNCED");
    // Depending on the mailparser version the report is inlined in the text or kept as an attachment (report).
    expect(`${message.email.report ?? ""}${message.email.text ?? ""}`).toContain("Final-Recipient: rfc822; marcus@hillcountrybody.example");
    expect(verdict.failedAddresses).toEqual(["marcus@hillcountrybody.example"]);
  });

  test("a report kept as an attachment is read too", () => {
    const verdict = classifyInbound({ from: "mailer-daemon@x.example", subject: "Returned mail", text: "Your message could not be delivered.", report: "Final-Recipient: rfc822; tom@beckerfilms.example\nAction: failed", headers: {} });
    expect(verdict.failedAddresses).toEqual(["tom@beckerfilms.example"]);
  });

  test("a bounce without a report still names the address it mentions", () => {
    const verdict = classifyInbound({ from: "postmaster@x.example", subject: "Undeliverable: hello", text: "Delivery to elena@ortizautoglass.example failed permanently.", headers: {} });
    expect(verdict).toMatchObject({ kind: "BOUNCED", failedAddresses: ["elena@ortizautoglass.example"] });
  });

  test("an out-of-office with Auto-Submitted is an automatic reply", async () => {
    const message = await parseMailboxMessage(
      ["From: priya@shinedetail.example", "Subject: Out of Office", "Auto-Submitted: auto-replied", "Message-ID: <ooo@shinedetail.example>", "Content-Type: text/plain", "", "Back on Monday."].join("\r\n"),
    );
    expect(classifyInbound(message.email).kind).toBe("AUTO_REPLY");
  });
});
