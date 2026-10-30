import type { RenderOptions, RenderResult, TemplateNode, Variables } from "../types";
import { parseTemplate } from "./parseTemplate";
import { pickVariant } from "./pickVariant";
import { tidyText } from "./tidyText";

/** A template that does not parse. `problems` holds one line per syntax error. */
export class TemplateError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join("; "));
    this.name = "TemplateError";
  }
}

/** Render parsed nodes. Values are trimmed; an empty value counts as missing. */
export function renderNodes(nodes: TemplateNode[], variables: Variables, options: RenderOptions): RenderResult {
  const missing = new Set<string>();
  const used = new Set<string>();
  let variantIndex = 0;

  const walk = (list: TemplateNode[]): string => {
    let out = "";
    for (const node of list) {
      if (node.kind === "text") {
        out += node.value;
      } else if (node.kind === "variable") {
        used.add(node.name);
        const value = variables[node.name]?.trim();
        if (value) out += value;
        else if (options.mode === "partial") out += `{{${node.name}}}`;
        else if (node.fallback !== undefined) out += node.fallback;
        else {
          missing.add(node.name);
          out += node.raw;
        }
      } else {
        const choice = pickVariant(`${options.seed}#${variantIndex++}`, node.options.length);
        out += walk(node.options[choice] ?? []);
      }
    }
    return out;
  };

  return { text: tidyText(walk(nodes)), missing: [...missing], used: [...used] };
}

/** Parse and render a template. Throws TemplateError on a syntax error. */
export function renderTemplate(source: string, variables: Variables, options: RenderOptions): RenderResult {
  const parsed = parseTemplate(source);
  if (parsed.errors.length > 0) throw new TemplateError(parsed.errors);
  return renderNodes(parsed.nodes, variables, options);
}
