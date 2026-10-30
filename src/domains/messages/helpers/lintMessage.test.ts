import { describe, expect, test } from "bun:test";
import type { Message } from "../types";
import { lintSequences } from "./lintLibrary";
import { lintMessage } from "./lintMessage";
import { toMessage } from "./toMessage";
import { toSequences } from "./toSequences";

const email = (body: string, front = "title: First\nday: 0\nsubject: \"hello {{company}}\"") => `---\n${front}\n---\n${body}\n`;

function parsed(rel: string, source: string): Message {
  const { message, issues } = toMessage(rel, source);
  if (!message) throw new Error(issues.map((i) => i.message).join("; "));
  return message;
}

const rules = (m: Message) => lintMessage(m).map((i) => `${i.level}:${i.rule}`);

describe("toMessage", () => {
  test("reads channel, voice, sequence and step from the path", () => {
    const m = parsed("email/personal/founder-direct/2-bump.md", email("Hi {{first_name|there}}", "title: Bump\nday: 3"));
    expect(m).toMatchObject({ id: "email/personal/founder-direct/2-bump", channel: "email", voice: "personal", sequence: "email/personal/founder-direct", step: 2, day: 3 });
  });

  test("rejects a bad path, voice or step file name", () => {
    expect(toMessage("email/team/x/1-a.md", email("x")).issues[0]?.rule).toBe("path");
    expect(toMessage("email/personal/x/first.md", email("x")).issues[0]?.rule).toBe("path");
    expect(toMessage("call/personal/nested/script.md", email("x")).issues[0]?.rule).toBe("path");
  });

  test("DMs need a platform, call scripts need a category", () => {
    expect(toMessage("dm/personal/linkedin/1-note.md", "---\ntitle: Note\nday: 0\n---\nHi").issues.map((i) => i.rule)).toContain("platform");
    expect(toMessage("call/company/opener.md", "---\ntitle: Opener\n---\n## Opener\nHi").issues.map((i) => i.rule)).toContain("category");
  });

  test("missing or broken front matter is an error", () => {
    expect(toMessage("call/personal/a.md", "## Opener\nHi").issues[0]?.rule).toBe("front-matter");
    expect(toMessage("call/personal/a.md", "---\ntitle: [unclosed\n---\nHi").issues[0]?.rule).toBe("front-matter");
  });
});

describe("lintMessage", () => {
  test("a clean first email passes", () => {
    expect(rules(parsed("email/personal/s/1-a.md", email("Hi {{first_name|there}},\n\n{{trigger}}\n\n{{sender_first_name}}")))).toEqual([]);
  });

  test("unknown variables are errors unless declared", () => {
    expect(rules(parsed("email/personal/s/1-a.md", email("Hi {{firstname}}")))).toContain("error:unknown-variable");
    const declared = parsed("email/personal/s/1-a.md", email("Hi {{nickname}}", 'title: A\nday: 0\nsubject: "x"\nvariables: [nickname]'));
    expect(rules(declared)).toEqual([]);
  });

  test("emojis, deceptive subjects and bracket placeholders are errors", () => {
    expect(rules(parsed("email/personal/s/1-a.md", email("Hi \u{1F44B}")))).toContain("error:no-emoji");
    expect(rules(parsed("email/personal/s/1-a.md", email("Hi", 'title: A\nday: 0\nsubject: "Re: your site"')))).toContain("error:subject");
    expect(rules(parsed("email/personal/s/1-a.md", email("Does [day] work?")))).toContain("error:placeholder");
  });

  test("a first email needs a subject; a follow-up does not", () => {
    expect(rules(parsed("email/personal/s/1-a.md", email("Hi", "title: A\nday: 0")))).toContain("error:subject");
    expect(rules(parsed("email/personal/s/2-a.md", email("Hi", "title: A\nday: 3")))).toEqual([]);
  });

  test("links in a first email warn unless allowed", () => {
    expect(rules(parsed("email/personal/s/1-a.md", email("See {{booking_url}}")))).toContain("warning:links");
    expect(rules(parsed("email/personal/s/1-a.md", email("See {{booking_url}}", 'title: A\nday: 0\nsubject: "x"\nlinks: true')))).toEqual([]);
  });

  test("a LinkedIn connection note over 200 characters is an error", () => {
    const long = "word ".repeat(50);
    const note = parsed("dm/personal/linkedin/1-note.md", `---\ntitle: Note\nplatform: linkedin\nday: 0\n---\n${long}`);
    expect(rules(note)).toContain("error:length");
  });

  test("call scripts need ## sections and may use [brackets]", () => {
    expect(rules(parsed("call/personal/a.md", "---\ntitle: A\ncategory: Introduction\n---\nHi there"))).toContain("error:sections");
    expect(rules(parsed("call/personal/a.md", "---\ntitle: A\ncategory: Introduction\n---\n## Opener\nDoes [day] work?"))).toEqual([]);
  });
});

describe("lintSequences", () => {
  const step = (n: number, day: number) => parsed(`email/personal/s/${n}-a.md`, email("Hi", `title: A\nday: ${day}\nsubject: "x"`));

  test("steps must be contiguous and days increasing from 0", () => {
    expect(lintSequences(toSequences([step(1, 0), step(2, 3), step(3, 7)]))).toEqual([]);
    expect(lintSequences(toSequences([step(1, 0), step(3, 7)])).map((i) => i.rule)).toContain("steps");
    expect(lintSequences(toSequences([step(1, 2), step(2, 3)])).map((i) => i.rule)).toContain("day");
    expect(lintSequences(toSequences([step(1, 0), step(2, 0)])).map((i) => i.rule)).toContain("day");
  });
});
