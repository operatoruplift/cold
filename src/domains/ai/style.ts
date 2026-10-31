/**
 * How a message is written for one person: its register (tone) and how it
 * opens (angle). The decision engine picks them per prospect and learns which
 * ones get replies; the writer follows the guide for each.
 */
export const TONES = ["formal", "professional", "conversational", "casual"] as const;
export type Tone = (typeof TONES)[number];

export const ANGLES = ["pain", "outcome", "proof", "trigger", "question"] as const;
export type Angle = (typeof ANGLES)[number];

export interface StyleGuide {
  label: string;
  /** When it fits: what the decision model weighs. */
  when: string;
  /** How to write it: what the writer follows. */
  write: string;
}

export const TONE_GUIDE: Record<Tone, StyleGuide> = {
  formal: {
    label: "Formal",
    when: "Law, finance, healthcare, government, large companies and senior executives; prospects whose own site and posts are formal.",
    write: "Full sentences, no contractions, no slang. Greet with title and surname when known (Dear Ms. Reyes), otherwise Hello and the first name. Polite and precise.",
  },
  professional: {
    label: "Professional",
    when: "Most business owners and managers; the safe choice when little is known about how they write.",
    write: "Clear and polite. Contractions are fine. Greet with the first name (Hi Dana). Plain words, no slang, no exclamation marks.",
  },
  conversational: {
    label: "Conversational",
    when: "Owner-run businesses, founders and trades; prospects who write warmly and personally on their own site or socials.",
    write: "Like a note from a peer: short sentences, contractions, first name, one light touch of personality. Still specific and respectful.",
  },
  casual: {
    label: "Casual",
    when: "Creators, studios, cafes and young brands with a relaxed online voice; DMs on Instagram or X.",
    write: "Very short and relaxed (Hey Dana). Plain everyday words, can be a little playful. Never sloppy, never rude, no emoji unless they use them.",
  },
};

export const ANGLE_GUIDE: Record<Angle, StyleGuide> = {
  pain: {
    label: "Their problem",
    when: "The evidence shows a specific problem the offer removes.",
    write: "Open with the problem they likely have, in their terms and only as the evidence shows it, then how the offer removes it.",
  },
  outcome: {
    label: "The result",
    when: "Their goal is clear (more bookings, more reviews, less admin) but no single problem stands out.",
    write: "Open with the result they want, concretely, then how you get them there.",
  },
  proof: {
    label: "Proof",
    when: "The seller has proof from a similar business, and the prospect will trust peers more than claims.",
    write: "Open with what you did for a similar business, using only the proof the seller gave. Never invent a customer, a number or a result.",
  },
  trigger: {
    label: "What just happened",
    when: "Something recent and specific happened at the business: an opening, a hire, a launch, a theme in reviews.",
    write: "Open with the recent event, as one true sentence, then connect it to the offer.",
  },
  question: {
    label: "A question",
    when: "Too little is known to assume their problem; a curious, low-pressure start suits them.",
    write: "Open with one short, specific question about their situation that the offer helps with. No trick or rhetorical questions.",
  },
};

/** What the writer is told about the person beyond the facts: the style, and what they need. */
export interface DraftStyle {
  tone: Tone;
  angle: Angle;
  /** Their needs, from diligence, most important first. */
  needs?: string[];
  /** What would most likely stop them saying yes. */
  objection?: string;
}
