import { describe, expect, test } from "bun:test";
import type { Touch } from "../types";
import { callOutcome, dialerTemplateId, isConversation, latestCall } from "./callOutcome";

const call = (disposition: string, at: string, extra: Partial<Touch> = {}): Touch => ({ kind: "CALLED", channel: "CALL", templateId: `dialer:${disposition}`, prospectKey: "k", occurredAt: at, ...extra });

describe("call outcomes", () => {
  test("a call the dialer logged carries its outcome; nothing else does", () => {
    expect(dialerTemplateId("APPOINTMENT_SET")).toBe("dialer:APPOINTMENT_SET");
    expect(callOutcome(call("INTERESTED", "2026-11-01T10:00:00Z"))).toBe("INTERESTED");
    expect(callOutcome(call("MAYBE", "2026-11-01T10:00:00Z"))).toBeUndefined();
    expect(callOutcome({ channel: "EMAIL", templateId: "dialer:INTERESTED" })).toBeUndefined();
    expect(callOutcome({ channel: "CALL", templateId: undefined })).toBeUndefined();
  });

  test("conversations, and the latest call", () => {
    expect(isConversation(call("CALLBACK", "2026-11-01T10:00:00Z"))).toBe(true);
    expect(isConversation(call("VOICEMAIL", "2026-11-01T10:00:00Z"))).toBe(false);
    const latest = latestCall([call("INTERESTED", "2026-11-01T10:00:00Z"), call("WRONG_NUMBER", "2026-11-02T10:00:00Z"), { kind: "SENT", channel: "EMAIL", prospectKey: "k", occurredAt: "2026-11-03T10:00:00Z" }]);
    expect(latest?.disposition).toBe("WRONG_NUMBER");
    expect(latestCall([])).toBeUndefined();
  });
});
