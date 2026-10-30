import { createInterface } from "node:readline/promises";

/** How runners talk to the person running them. Swapped for a scripted one in tests. */
export interface Io {
  log(line?: string): void;
  /** Yes/no. Resolves false without a TTY. */
  confirm(question: string): Promise<boolean>;
  /** One key from `choices` (lowercase letters). Resolves "q" without a TTY. */
  choose(question: string, choices: string[]): Promise<string>;
  readonly interactive: boolean;
}

const useColor = !process.env.NO_COLOR && process.stdout.isTTY;
const paint = (code: number) => (text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
export const bold = paint(1);
export const dim = paint(2);
export const red = paint(31);
export const green = paint(32);
export const yellow = paint(33);
export const cyan = paint(36);

/** The terminal: stdout for output, stdin for answers. */
export function terminalIo(): Io {
  const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY;
  const ask = async (question: string) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await rl.question(question)).trim().toLowerCase();
    } finally {
      rl.close();
    }
  };
  return {
    interactive,
    log: (line = "") => console.log(line),
    confirm: async (question) => (interactive ? ["y", "yes"].includes(await ask(`${question} [y/N] `)) : false),
    choose: async (question, choices) => {
      if (!interactive) return "q";
      for (;;) {
        const answer = (await ask(`${question} `)).slice(0, 1);
        if (choices.includes(answer)) return answer;
      }
    },
  };
}

/** Indent every line of a block. */
export const indent = (text: string, pad = "    ") =>
  text
    .split("\n")
    .map((line) => (line ? pad + line : line))
    .join("\n");

/** Count of each reason: "2 replied, 1 no email address". */
export function countReasons(reasons: string[]): string {
  const counts = new Map<string, number>();
  for (const r of reasons) counts.set(r, (counts.get(r) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `${n} ${reason}`)
    .join(", ");
}

/** A plain text table with padded columns. */
export function table(rows: string[][]): string {
  const widths = rows[0]?.map((_, col) => Math.max(...rows.map((r) => (r[col] ?? "").length))) ?? [];
  return rows.map((r) => r.map((cell, col) => (col === r.length - 1 ? cell : cell.padEnd(widths[col]!))).join("  ")).join("\n");
}
