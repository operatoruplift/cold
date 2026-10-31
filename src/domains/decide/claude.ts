import { aiModel, askStructured, type Effort, type MessagesCall } from "../ai";
import { argmax, clamp01, concentration, normalize } from "./math";
import type { Answer, DecisionProvider, DecisionRequest, DecisionResult, Question } from "./types";

const SYSTEM = `You answer typed questions about one sales prospect for COLD, an outreach tool. Each question comes with instructions and the options to weigh; you answer every one, from the evidence in <state> only.

How to answer:
- noul: the probability, from 0 to 1, that the answer is yes.
- choice: a probability for every option, together adding up to 1.
- score: a probability for every level (0 is the lowest), together adding up to 1.
- Let the probabilities say how sure the evidence makes you. When the evidence is thin or silent, stay near even odds rather than guessing; never invent a fact to be decisive.
- Each reason is one short sentence that names the evidence it rests on, or says that there is none.`;

const reasonField = { type: "string", description: "One short sentence: the evidence this rests on." };

function propertyFor(question: Question): Record<string, unknown> {
  if (question.type === "noul") {
    return {
      type: "object",
      additionalProperties: false,
      required: ["probability", "reason"],
      properties: { probability: { type: "number", description: "0 to 1: how likely the answer is yes." }, reason: reasonField },
    };
  }
  const options = question.type === "choice" ? Object.keys(question.criteria) : question.criteria.map((_, i) => String(i));
  return {
    type: "object",
    additionalProperties: false,
    required: ["probabilities", "reason"],
    properties: {
      probabilities: { type: "object", additionalProperties: false, required: options, properties: Object.fromEntries(options.map((o) => [o, { type: "number" }])) },
      reason: reasonField,
    },
  };
}

function describe(id: string, question: Question): string {
  const options =
    question.type === "noul"
      ? question.criteria
        ? `  yes: ${question.criteria.true}\n  no: ${question.criteria.false}`
        : ""
      : question.type === "choice"
        ? Object.entries(question.criteria)
            .map(([option, text]) => `  ${option}: ${text}`)
            .join("\n")
        : question.criteria.map((text, i) => `  ${i}: ${text}`).join("\n");
  return `<question id="${id}" type="${question.type}">\n${question.instructions}\n${options}\n</question>`;
}

type Raw = { probability?: number; probabilities?: Record<string, number>; reason?: string };

/** Turn Claude's probabilities into the answers Jev would give, with a confidence worked out the same way. */
function toAnswer(question: Question, raw: Raw | undefined): Answer {
  const reason = raw?.reason?.trim() || undefined;
  if (question.type === "noul") return { type: "noul", noul: clamp01(raw?.probability ?? 0.5), reason };
  if (question.type === "choice") {
    const probabilities = normalize(raw?.probabilities, Object.keys(question.criteria));
    return { type: "choice", choice: argmax(probabilities), confidence: concentration(probabilities), probabilities, reason };
  }
  const levels = question.criteria.map((_, i) => String(i));
  const probabilities = normalize(raw?.probabilities, levels);
  return { type: "score", score: levels.reduce((sum, l) => sum + Number(l) * probabilities[l]!, 0), confidence: concentration(probabilities), probabilities, reason };
}

/**
 * Claude, answering the same typed questions with structured output, for
 * when there is no TypeSafe key. Its probabilities are its judgment rather
 * than a calibrated model's, and every answer comes with a reason.
 */
export function claudeDecider(options: { call: MessagesCall; model?: string; effort?: Effort }): DecisionProvider {
  const model = options.model ?? aiModel();
  return {
    name: "claude",
    model,
    async decide(request: DecisionRequest): Promise<DecisionResult> {
      const ids = Object.keys(request.questions);
      const schema = {
        type: "object",
        additionalProperties: false,
        required: ids,
        properties: Object.fromEntries(ids.map((id) => [id, propertyFor(request.questions[id]!)])),
      };
      const state = typeof request.state === "string" ? request.state : JSON.stringify(request.state, null, 1);
      const prompt = `<state>\n${state}\n</state>\n\n${ids.map((id) => describe(id, request.questions[id]!)).join("\n\n")}\n\nAnswer every question.`;
      const result = await askStructured<Record<string, Raw>>({ call: options.call, model, system: SYSTEM, prompt, effort: options.effort ?? "medium", maxTokens: 16000, schema });
      const answers = Object.fromEntries(ids.map((id) => [id, toAnswer(request.questions[id]!, result.output[id])]));
      return { answers, model: result.model, usage: result.usage };
    },
  };
}
