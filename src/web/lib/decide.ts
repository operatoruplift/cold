import type { Angle, Tone } from "../../domains/ai/style";
import type { Action, Objection, Tier } from "../../domains/decide/model";
import type { Tone as PillTone } from "../ui/kit";

/** Words for the decision engine's choices, as the screens show them. */
export const TONE_LABEL: Record<Tone, string> = { formal: "Formal", professional: "Professional", conversational: "Conversational", casual: "Casual" };
export const ANGLE_LABEL: Record<Angle, string> = { pain: "Their problem", outcome: "The result", proof: "Proof", trigger: "What just happened", question: "A question" };
export const ACTION_LABEL: Record<Action, string> = { contact_now: "Reach out now", nurture: "Later", research_more: "Research first", skip: "Skip" };
export const ACTION_TONE: Record<Action, PillTone> = { contact_now: "green", nurture: "blue", research_more: "amber", skip: "gray" };
export const TIER_TONE: Record<Tier, PillTone> = { A: "green", B: "blue", C: "amber", D: "gray" };
export const OBJECTION_LABEL: Record<Objection, string> = {
  already_solved: "They may already have this solved",
  no_budget: "Money may be tight",
  no_time: "They may be too busy right now",
  not_a_priority: "It may not be a priority for them",
  trust: "They'll want proof before trusting you",
  none_clear: "No clear objection",
};
export const FACTOR_LABEL = { fit: "Fit", need: "Need", timing: "Timing", authority: "Decision-maker", budget: "Can pay", reach: "Reachable" } as const;
export const TONES: Tone[] = ["formal", "professional", "conversational", "casual"];
export const ANGLES: Angle[] = ["pain", "outcome", "proof", "trigger", "question"];
export const PROVIDER_LABEL: Record<string, string> = { jev: "Jev", claude: "Claude", subq: "SubQ" };

export const pct = (x: number) => `${Math.round(x * 100)}%`;
