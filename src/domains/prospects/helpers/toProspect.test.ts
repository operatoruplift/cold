import { describe, expect, test } from "bun:test";
import { linkedinSlug, socialHandle, toSnakeCase, websiteHost } from "./normalize";
import { parseCsv } from "./parseCsv";
import { fromAgencyPerson, fromAgencyProspect, fromCsvRow, fromPerson } from "./toProspect";

describe("parseCsv", () => {
  test("handles quotes, escaped quotes, commas and newlines in fields, CRLF and a BOM", () => {
    const text = '﻿id,trigger,note\r\n1,"Saw your post, nice","He said ""hi"""\r\n2,"two\nlines",\r\n\r\n';
    expect(parseCsv(text)).toEqual([
      ["id", "trigger", "note"],
      ["1", "Saw your post, nice", 'He said "hi"'],
      ["2", "two\nlines", ""],
    ]);
  });
});

describe("normalizers", () => {
  test("snake_case, profiles and hosts", () => {
    expect(toSnakeCase("reviewCount")).toBe("review_count");
    expect(toSnakeCase("First Name")).toBe("first_name");
    expect(linkedinSlug("https://www.linkedin.com/in/Dana-Reyes/?trk=x")).toBe("dana-reyes");
    expect(socialHandle("https://x.com/ClearviewTint")).toBe("clearviewtint");
    expect(socialHandle("@shine.detail")).toBe("shine.detail");
    expect(websiteHost("https://www.Clearview.com/book?x=1")).toBe("clearview.com");
  });
});

describe("fromCsvRow", () => {
  const headers = ["id", "First Name", "company", "email", "website", "linkedin_url", "trigger", "do_not_contact"];

  test("maps columns to variables and derives the rest", () => {
    const p = fromCsvRow(headers, ["p01", "Dana", "Clearview Tint", "Dana@Clearview.example ", "https://www.clearview.example/", "https://linkedin.com/in/dana", "Saw the new bay.", ""], 0);
    expect(p.key).toBe("email:dana@clearview.example");
    expect(p.identities).toEqual(["email:dana@clearview.example", "linkedin:dana", "csv:p01"]);
    expect(p.variables).toMatchObject({ first_name: "Dana", full_name: "Dana", website: "clearview.example", trigger: "Saw the new bay." });
    expect(p.label).toBe("Dana (Clearview Tint)");
    expect(p.doNotContact).toBe(false);
  });

  test("a truthy do_not_contact column marks the prospect", () => {
    expect(fromCsvRow(headers, ["p02", "Tom", "Becker", "", "", "", "", "yes"], 1).doNotContact).toBe(true);
  });
});

describe("Twenty records", () => {
  test("a standard person with its company", () => {
    const p = fromPerson(
      {
        id: "per-1",
        companyId: "co-1",
        name: { firstName: "Dana", lastName: "Reyes" },
        emails: { primaryEmail: "DANA@clearview.example", additionalEmails: [] },
        phones: { primaryPhoneNumber: "5125550101", primaryPhoneCallingCode: "+1" },
        linkedinLink: { primaryLinkUrl: "https://linkedin.com/in/dana-reyes" },
        jobTitle: "Owner",
        coldTrigger: "Saw you opened a second bay.",
      },
      { id: "co-1", name: "Clearview Tint", domainName: { primaryLinkUrl: "https://clearview.example" }, address: { addressCity: "Austin" } },
    );
    expect(p.key).toBe("person:per-1");
    expect(p.links).toEqual({ personId: "per-1", companyId: "co-1" });
    expect(p.variables).toMatchObject({ first_name: "Dana", last_name: "Reyes", full_name: "Dana Reyes", email: "dana@clearview.example", phone: "+15125550101", company: "Clearview Tint", website: "clearview.example", city: "Austin", title: "Owner", trigger: "Saw you opened a second bay." });
  });

  test("the dialer's prospect, and Do Not Contact from its call status or SMS state", () => {
    const base = { id: "ap-1", name: "Clearview Tint", decisionMaker: "Dana Reyes", email: "dana@clearview.example", phone: "+15125550101", website: "clearview.example", city: "Austin", reviewCount: 212, rating: 4.8, videoUrl: { primaryLinkUrl: "https://cap.so/s/x" }, coldCallStatus: "NEW" };
    const p = fromAgencyProspect(base);
    expect(p.variables).toMatchObject({ company: "Clearview Tint", first_name: "Dana", review_count: "212", rating: "4.8", video_url: "https://cap.so/s/x" });
    expect(p.links).toEqual({ agencyProspectId: "ap-1" });
    expect(p.doNotContact).toBe(false);
    expect(fromAgencyProspect({ ...base, coldCallStatus: "DO_NOT_CONTACT" }).doNotContact).toBe(true);
    expect(fromAgencyProspect({ ...base, outboundState: "OPTED_OUT" }).doNotContact).toBe(true);
  });

  test("a person at a dialer prospect inherits the business and its Do Not Contact", () => {
    const p = fromAgencyPerson(
      { id: "pp-1", name: "Dana Reyes", jobTitle: "Owner", prospectId: "ap-1", linkedinLink: { primaryLinkUrl: "https://linkedin.com/in/dana-reyes" }, xLink: { primaryLinkUrl: "https://x.com/danar" } },
      { id: "ap-1", name: "Clearview Tint", city: "Austin", coldCallStatus: "DO_NOT_CONTACT" },
    );
    expect(p.key).toBe("agencyPerson:pp-1");
    expect(p.variables).toMatchObject({ company: "Clearview Tint", first_name: "Dana", x_handle: "danar", city: "Austin" });
    expect(p.xHandle).toBe("danar");
    expect(p.doNotContact).toBe(true);
    expect(p.links).toEqual({ agencyPersonId: "pp-1", agencyProspectId: "ap-1" });
  });
});
