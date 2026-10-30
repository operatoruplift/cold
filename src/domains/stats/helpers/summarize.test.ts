import { expect, test } from "bun:test";
import type { Touch } from "../../touches";
import { rate, summarize } from "./summarize";

const t = (kind: Touch["kind"], key: string, step: number, seq = "email/personal/founder-direct"): Touch => ({
  kind,
  channel: "EMAIL",
  sequence: seq,
  step,
  templateId: `${seq}/${step}`,
  prospectKey: key,
  occurredAt: "2026-11-02T00:00:00Z",
});

test("summarize counts per message and per sequence", () => {
  const { templates, sequences } = summarize([t("SENT", "a", 1), t("SENT", "b", 1), t("SENT", "c", 1), t("SENT", "a", 2), t("REPLIED", "a", 2), t("OPTED_OUT", "b", 1), t("BOUNCED", "c", 1)]);
  expect(templates.map((r) => [r.templateId, r.sent, r.replied, r.optedOut, r.bounced])).toEqual([
    ["email/personal/founder-direct/1", 3, 0, 1, 1],
    ["email/personal/founder-direct/2", 1, 1, 0, 0],
  ]);
  expect(sequences).toEqual([{ sequence: "email/personal/founder-direct", started: 3, replied: 1, optedOut: 1 }]);
  expect(rate(1, 3)).toBe("33.3%");
  expect(rate(0, 0)).toBe("-");
});
