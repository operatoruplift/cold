import { describe, expect, test } from "bun:test";
import type { Touch } from "../../touches";
import { addressOf } from "./address";
import { buildEmail } from "./buildEmail";
import { classifyInbound, newTextOf } from "./classifyInbound";
import { describeWindow, isInWindow } from "./sendWindow";

const first: Touch = {
  kind: "SENT",
  channel: "EMAIL",
  prospectKey: "email:dana@x.example",
  subject: "quick question about Clearview Tint",
  body: "Hi Dana,\n\nSaw the new bay.\n\nAlex",
  messageId: "<one@brightside.example>",
  fromAddress: "alex@brightside.example",
  occurredAt: "2026-11-02T15:00:00.000Z",
};

describe("buildEmail", () => {
  test("step 1 starts a thread, with the footer and a mailto unsubscribe", () => {
    const draft = buildEmail({ from: "Alex <alex@brightside.example>", to: "dana@x.example", subject: "quick question", body: "Hi Dana", footer: "123 Example St\nReply stop", messageId: "<m1@brightside.example>" });
    expect(draft.subject).toBe("quick question");
    expect(draft.text).toBe("Hi Dana\n\n123 Example St\nReply stop\n");
    expect(draft.inReplyTo).toBeUndefined();
    expect(draft.headers["List-Unsubscribe"]).toBe("<mailto:alex@brightside.example?subject=unsubscribe>");
    expect(draft.headers["List-Unsubscribe-Post"]).toBeUndefined();
  });

  test("a follow-up replies in the thread and quotes the previous email", () => {
    const draft = buildEmail({ from: "Alex <alex@brightside.example>", to: "dana@x.example", body: "Bumping this.", footer: "Footer", first, previous: first, messageId: "<m2@b>", timeZone: "America/Chicago" });
    expect(draft.subject).toBe("Re: quick question about Clearview Tint");
    expect(draft.inReplyTo).toBe("<one@brightside.example>");
    expect(draft.references).toEqual(["<one@brightside.example>"]);
    expect(draft.text).toContain("Bumping this.\n\nFooter\n\nOn Mon, Nov 2, 2026, alex@brightside.example wrote:\n> Hi Dana,\n>\n> Saw the new bay.");
  });

  test("an https unsubscribe URL adds one-click unsubscribe", () => {
    const draft = buildEmail({ from: "a@b.example", to: "c@d.example", subject: "s", body: "b", footer: "f", messageId: "<m>", unsubscribeUrl: "https://b.example/u?e=c%40d.example" });
    expect(draft.headers["List-Unsubscribe"]).toBe("<mailto:a@b.example?subject=unsubscribe>, <https://b.example/u?e=c%40d.example>");
    expect(draft.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });
});

describe("classifyInbound", () => {
  const reply = (text: string, subject = "Re: quick question", headers: Record<string, string> = {}) => classifyInbound({ from: "dana@x.example", subject, text, headers });

  test("a normal reply", () => {
    expect(reply("Sure, send the video over.\n\nOn Mon, Alex wrote:\n> Reply stop to opt out").kind).toBe("REPLIED");
  });

  test("opt-outs, but never from the quoted footer", () => {
    expect(reply("Please remove me from your list.").kind).toBe("OPTED_OUT");
    expect(reply("STOP").kind).toBe("OPTED_OUT");
    expect(reply("unsubscribe").kind).toBe("OPTED_OUT");
    expect(reply("Thanks!\n> Not for you? Reply \"stop\" and I won't email you again.").kind).toBe("REPLIED");
  });

  test("out-of-office replies are automatic, not replies", () => {
    expect(reply("I'm away until Monday.", "Automatic reply: quick question").kind).toBe("AUTO_REPLY");
    expect(reply("Away", "Re: x", { "auto-submitted": "auto-replied" }).kind).toBe("AUTO_REPLY");
  });

  test("bounces, with the failed address from the delivery report", () => {
    const verdict = classifyInbound({
      from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
      subject: "Delivery Status Notification (Failure)",
      text: "Address not found\n\nReporting-MTA: dns; googlemail.com\nFinal-Recipient: rfc822; dana@x.example\nAction: failed",
      headers: { "content-type": "multipart/report; report-type=delivery-status; boundary=x" },
    });
    expect(verdict).toMatchObject({ kind: "BOUNCED", failedAddresses: ["dana@x.example"] });
  });

  test("newTextOf stops at the quoted message", () => {
    expect(newTextOf("Yes please.\n\nOn Mon, Nov 2, 2026, Alex wrote:\n> old")).toBe("Yes please.");
    expect(newTextOf("Ok\n-----Original Message-----\nFrom: x")).toBe("Ok");
  });
});

describe("send window", () => {
  const window = { days: ["mon", "tue", "wed", "thu"] as const, start: "08:00", end: "17:00", timezone: "America/Chicago" };
  test("open and closed, in the window's timezone", () => {
    expect(isInWindow(new Date("2026-11-02T15:00:00Z"), { ...window, days: [...window.days] })).toBe(true); // Mon 09:00 Chicago
    expect(isInWindow(new Date("2026-11-02T23:30:00Z"), { ...window, days: [...window.days] })).toBe(false); // Mon 17:30
    expect(isInWindow(new Date("2026-11-06T15:00:00Z"), { ...window, days: [...window.days] })).toBe(false); // Friday
    expect(describeWindow({ ...window, days: [...window.days] })).toBe("mon-thu 08:00-17:00 America/Chicago");
  });
});

test("addressOf", () => {
  expect(addressOf("Alex Morgan <Alex@Brightside.example>")).toBe("alex@brightside.example");
});

test("headerText flattens structured header values", async () => {
  const { headerText } = await import("./headerText");
  expect(headerText({ value: "multipart/report", params: { "report-type": "delivery-status" } })).toBe("multipart/report; report-type=delivery-status");
  expect(headerText({ text: "Dana <dana@x.example>", value: [{ address: "dana@x.example" }] })).toBe("Dana <dana@x.example>");
  expect(headerText("auto-replied")).toBe("auto-replied");
});

describe("review fixes: inbound", () => {
  const reply = (text: string, subject = "Re: quick question") => classifyInbound({ from: "dana@x.example", subject, text, headers: {} });

  test('"Stop by the shop" is a reply, not an opt-out', () => {
    expect(reply("Stop by the shop Tuesday and we can talk.").kind).toBe("REPLIED");
    expect(reply("Please stop.").kind).toBe("OPTED_OUT");
    expect(reply("stop emailing me").kind).toBe("OPTED_OUT");
  });

  test("a stop written below the quoted email still counts", () => {
    expect(reply("On Mon, Alex wrote:\n> Hi Dana,\n> Not for you? Reply \"stop\"\n\nSTOP").kind).toBe("OPTED_OUT");
    expect(reply("On Mon, Alex wrote:\n> Hi Dana,\n> Reply \"unsubscribe\" and we'll take you off\n\nSure, Tuesday works.").kind).toBe("REPLIED");
  });

  test("a delivery delay is not a bounce", () => {
    const delay = classifyInbound({
      from: "mailer-daemon@googlemail.com",
      subject: "Delivery Status Notification (Delay)",
      text: "Message not delivered yet. Gmail will retry for 46 more hours.\n\nFinal-Recipient: rfc822; dana@x.example\nAction: delayed\nStatus: 4.4.7",
      headers: { "content-type": "multipart/report; report-type=delivery-status" },
    });
    expect(delay.kind).toBe("DELAYED");
    expect(classifyInbound({ from: "postmaster@x.example", subject: "Delivery Status Notification (Delay)", text: "Still trying.", headers: {} }).kind).toBe("DELAYED");
  });

  test("a report with one failed and one delayed recipient bounces only the failed one", () => {
    const verdict = classifyInbound({
      from: "mailer-daemon@x.example",
      subject: "Undelivered Mail Returned to Sender",
      text: "Final-Recipient: rfc822; a@x.example\nAction: failed\nStatus: 5.1.1\n\nFinal-Recipient: rfc822; b@x.example\nAction: delayed\nStatus: 4.4.1",
      headers: {},
    });
    expect(verdict).toMatchObject({ kind: "BOUNCED", failedAddresses: ["a@x.example"] });
  });
});

describe("classifySmtpFailure", () => {
  test("only a permanent RCPT TO refusal is the recipient's bounce", async () => {
    const { classifySmtpFailure } = await import("./smtpFailure");
    expect(classifySmtpFailure({ code: "EENVELOPE", responseCode: 550, command: "RCPT TO" })).toBe("recipient");
    expect(classifySmtpFailure({ code: "EENVELOPE", responseCode: 550, command: "MAIL FROM" })).toBe("mailbox");
    expect(classifySmtpFailure({ code: "EMESSAGE", responseCode: 554, command: "DATA" })).toBe("mailbox");
    expect(classifySmtpFailure({ code: "EAUTH", command: "AUTH PLAIN" })).toBe("mailbox");
    expect(classifySmtpFailure({ code: "EENVELOPE", responseCode: 450, command: "RCPT TO" })).toBe("temporary");
    expect(classifySmtpFailure({ code: "EENVELOPE", command: "API" })).toBe("other");
  });
});
