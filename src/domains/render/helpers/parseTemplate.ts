import type { ParsedTemplate, TemplateNode } from "../types";

const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/;

/**
 * Parse a message template. Three constructs:
 *
 *   {{name}}            a variable
 *   {{name|fallback}}   a variable with the text used when it is empty
 *   {a|b|c}             variants (spintax): one option is picked per prospect;
 *                       options may contain variables and nest
 *
 * A backslash escapes { } and |. Square brackets are plain text. Pure: syntax
 * errors are collected with their line number, never thrown.
 */
export function parseTemplate(source: string): ParsedTemplate {
  const errors: string[] = [];
  let i = 0;
  const lineOf = (at: number) => source.slice(0, at).split("\n").length;

  function sequence(inVariants: boolean): TemplateNode[] {
    const nodes: TemplateNode[] = [];
    let text = "";
    const flush = () => {
      if (text) nodes.push({ kind: "text", value: text });
      text = "";
    };

    while (i < source.length) {
      const c = source[i]!;
      const next = source[i + 1];

      if (c === "\\" && next !== undefined && "{}|".includes(next)) {
        text += next;
        i += 2;
        continue;
      }

      if (c === "{" && next === "{") {
        const end = source.indexOf("}}", i + 2);
        if (end === -1) {
          errors.push(`line ${lineOf(i)}: "{{" is never closed`);
          text += source.slice(i);
          i = source.length;
          break;
        }
        const raw = source.slice(i, end + 2);
        const inner = source.slice(i + 2, end);
        const bar = inner.indexOf("|");
        const name = (bar === -1 ? inner : inner.slice(0, bar)).trim();
        if (!VARIABLE_NAME.test(name)) errors.push(`line ${lineOf(i)}: ${raw} is not a valid variable (use lower_snake_case)`);
        flush();
        nodes.push(bar === -1 ? { kind: "variable", name, raw } : { kind: "variable", name, fallback: inner.slice(bar + 1), raw });
        i = end + 2;
        continue;
      }

      if (c === "{") {
        const start = i;
        i += 1;
        flush();
        const options: TemplateNode[][] = [];
        let closed = false;
        for (;;) {
          options.push(sequence(true));
          if (i >= source.length) break;
          const stop = source[i];
          i += 1;
          if (stop === "}") {
            closed = true;
            break;
          }
        }
        const raw = source.slice(start, i);
        if (!closed) errors.push(`line ${lineOf(start)}: "{" is never closed`);
        else if (options.length < 2) errors.push(`line ${lineOf(start)}: ${raw} needs at least two options, like {Hi|Hey}`);
        nodes.push({ kind: "variants", options, raw });
        continue;
      }

      if (inVariants && (c === "|" || c === "}")) break;
      if (c === "}") errors.push(`line ${lineOf(i)}: "}" has no opening "{"`);
      text += c;
      i += 1;
    }

    flush();
    return nodes;
  }

  return { nodes: sequence(false), errors };
}

/** Every variable name in the template, in every variant, in order of first use. */
export function collectVariables(nodes: TemplateNode[]): string[] {
  const names: string[] = [];
  const walk = (list: TemplateNode[]) => {
    for (const node of list) {
      if (node.kind === "variable" && !names.includes(node.name)) names.push(node.name);
      if (node.kind === "variants") node.options.forEach(walk);
    }
  };
  walk(nodes);
  return names;
}
