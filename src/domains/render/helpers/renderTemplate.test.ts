import { describe, expect, test } from "bun:test";
import { collectVariables, parseTemplate } from "./parseTemplate";
import { renderTemplate, TemplateError } from "./renderTemplate";
import { tidyText } from "./tidyText";

const strict = { mode: "strict" as const, seed: "p01" };

describe("variables", () => {
  test("fills values and trims them", () => {
    expect(renderTemplate("Hi {{first_name}},", { first_name: "  Dana " }, strict).text).toBe("Hi Dana,");
  });

  test("uses the fallback when the value is empty or missing", () => {
    expect(renderTemplate("Hi {{first_name|there}},", { first_name: "" }, strict).text).toBe("Hi there,");
    expect(renderTemplate("Hi {{first_name|there}},", {}, strict).text).toBe("Hi there,");
  });

  test("an empty fallback makes a variable optional, and tidies the gap", () => {
    expect(renderTemplate("Thanks {{first_name|}}, talk soon.", {}, strict).text).toBe("Thanks, talk soon.");
  });

  test("strict mode reports a missing variable and leaves it visible", () => {
    const result = renderTemplate("{{trigger}} I build pages.", {}, strict);
    expect(result.missing).toEqual(["trigger"]);
    expect(result.text).toBe("{{trigger}} I build pages.");
  });

  test("partial mode keeps unknown variables as {{name}}, even with a fallback", () => {
    const result = renderTemplate("Hi {{first_name|there}}, it's {{sender_first_name}}.", { sender_first_name: "Alex" }, { mode: "partial", seed: "s" });
    expect(result.text).toBe("Hi {{first_name}}, it's Alex.");
    expect(result.missing).toEqual([]);
  });
});

describe("variants", () => {
  test("the same seed always picks the same option", () => {
    const template = "{Hi|Hey|Hello} {{first_name}}";
    const a = renderTemplate(template, { first_name: "Dana" }, { mode: "strict", seed: "p01" }).text;
    for (let n = 0; n < 5; n++) expect(renderTemplate(template, { first_name: "Dana" }, { mode: "strict", seed: "p01" }).text).toBe(a);
  });

  test("different seeds spread across the options", () => {
    const seen = new Set<string>();
    for (let n = 0; n < 60; n++) seen.add(renderTemplate("{a|b|c}", {}, { mode: "strict", seed: `p${n}` }).text);
    expect(seen).toEqual(new Set(["a", "b", "c"]));
  });

  test("options can hold variables and nest", () => {
    const text = renderTemplate("{quick question|question {about {{company}}|for you}}", { company: "Clearview" }, { mode: "strict", seed: "x" }).text;
    expect(["quick question", "question about Clearview", "question for you"]).toContain(text);
  });

  test("backslash escapes braces and bars", () => {
    expect(renderTemplate("a \\{literal\\} \\| bar", {}, strict).text).toBe("a {literal} | bar");
  });
});

describe("syntax errors", () => {
  test("are reported with line numbers, not thrown, by the parser", () => {
    const { errors } = parseTemplate("line one\n{{first name}}\n{Hi\n");
    expect(errors.some((e) => e.startsWith("line 2:"))).toBe(true);
    expect(errors.some((e) => e.includes("never closed"))).toBe(true);
  });

  test("a single-option variant and a stray brace are errors", () => {
    expect(parseTemplate("{only}").errors[0]).toContain("at least two options");
    expect(parseTemplate("oops }").errors[0]).toContain('"}" has no opening');
  });

  test("renderTemplate throws TemplateError", () => {
    expect(() => renderTemplate("{{unclosed", {}, strict)).toThrow(TemplateError);
  });

  test("square brackets are plain text", () => {
    expect(parseTemplate("Does [day] or [day] work?").errors).toEqual([]);
  });
});

test("collectVariables finds names in every variant", () => {
  const { nodes } = parseTemplate("{Hi {{first_name}}|Hey {{full_name}}} from {{sender_company}}, {{first_name}}");
  expect(collectVariables(nodes)).toEqual(["first_name", "full_name", "sender_company"]);
});

test("tidyText keeps indentation and collapses blank runs", () => {
  expect(tidyText("  - item  one  \n\n\n\nnext ,")).toBe("- item one\n\nnext,");
  expect(tidyText("a\n  - nested")).toBe("a\n  - nested");
});
