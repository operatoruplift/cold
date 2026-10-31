import type { AiUsage } from "../ai";

/**
 * A typed question, in TypeSafe's own vocabulary so the Jev adapter sends it
 * as is: a noul is yes or no with a probability, a choice picks one of named
 * options, a score places the answer on ordered levels (lowest first).
 */
export type Question =
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

/**
 * An answer. Probabilities are 0 to 1. Confidence is how concentrated a
 * choice's or score's probabilities are, not the chance it is right; a noul
 * has none, since its probability already says how sure it is.
 */
export type Answer =
  | { type: "noul"; noul: number; reason?: string }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number>; reason?: string }
  | { type: "score"; score: number; confidence: number; probabilities: Record<string, number>; reason?: string };

export interface DecisionRequest {
  /** What the questions are about, read once for all of them: text, or JSON. */
  state: string | Record<string, unknown>;
  questions: Record<string, Question>;
}

export interface DecisionResult {
  answers: Record<string, Answer>;
  model: string;
  usage: AiUsage;
}

/** Who answers the questions: Jev, or Claude when there is no TypeSafe key. */
export interface DecisionProvider {
  readonly name: "jev" | "claude";
  readonly model: string;
  decide(request: DecisionRequest): Promise<DecisionResult>;
}

/** A fetch, as the page collector and the API adapters use it. Tests pass a fake. */
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
