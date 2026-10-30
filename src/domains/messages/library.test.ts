import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { VARIABLES } from "../render";
import { findMessage, findSequence, loadLibrary, MESSAGES_DIR } from ".";

describe("the bundled message library", () => {
  const { library, issues } = loadLibrary();

  test("has no lint errors or warnings", () => {
    expect(issues.map((i) => `${i.level} ${i.file} [${i.rule}] ${i.message}`)).toEqual([]);
  });

  test("covers every channel in both voices", () => {
    for (const channel of ["email", "dm", "call"] as const) {
      for (const voice of ["personal", "company"] as const) {
        expect(library.messages.some((m) => m.channel === channel && m.voice === voice)).toBe(true);
      }
    }
  });

  test("covers LinkedIn, X and Instagram DMs in both voices", () => {
    for (const voice of ["personal", "company"]) {
      for (const platform of ["linkedin", "x", "instagram"]) {
        expect(library.sequences.some((s) => s.channel === "dm" && s.voice === voice && s.platform === platform)).toBe(true);
      }
    }
  });

  test("every voice has a voicemail script and objection responses", () => {
    expect(library.callScripts.filter((m) => m.id.endsWith("/voicemail")).map((m) => m.voice).sort()).toEqual(["company", "personal"]);
    expect(library.objections.length).toBeGreaterThanOrEqual(10);
  });

  test("finds sequences and messages by full id or unique suffix", () => {
    expect(findSequence(library, "email/personal/founder-direct")?.steps.length).toBe(4);
    expect(findSequence(library, "founder-direct")?.id).toBe("email/personal/founder-direct");
    expect(findSequence(library, "right-person")).toBeUndefined(); // personal and company: ambiguous
    expect(findMessage(library, "call/company/gatekeeper")?.category).toBe("General");
  });

  test("messages/README.md documents every variable in the contract", () => {
    const readme = readFileSync(path.join(MESSAGES_DIR, "README.md"), "utf8");
    const undocumented = VARIABLES.filter((v) => !readme.includes(`\`{{${v.name}}}\``)).map((v) => v.name);
    expect(undocumented).toEqual([]);
  });
});

describe("the docs match the library", () => {
  const { library } = loadLibrary();
  const root = path.resolve(MESSAGES_DIR, "..");

  test("README.md states the right counts", () => {
    const readme = readFileSync(path.join(root, "README.md"), "utf8");
    expect(readme).toContain(`${library.messages.length} messages`);
    expect(readme).toContain(`${library.objections.length} objection answers`);
  });

  test("messages/README.md lists every sequence with its steps, and every call script", () => {
    const tree = readFileSync(path.join(MESSAGES_DIR, "README.md"), "utf8");
    for (const s of library.sequences) {
      const folder = s.id.split("/").pop()!;
      const steps = s.steps.map((m) => m.id.split("/").pop()!).join("  ");
      expect(tree).toMatch(new RegExp(`${folder}/\\s+${steps.replace(/[-]/g, "\\-")}\\n`));
    }
    for (const voice of ["personal", "company"] as const) {
      const names = library.callScripts.filter((m) => m.voice === voice).map((m) => m.id.split("/").pop()!);
      for (const name of names) expect(tree).toMatch(new RegExp(`${voice}/\\s+.*\\b${name}\\b`));
    }
    expect(tree).toContain(`${library.objections.length} objections`);
  });
});
