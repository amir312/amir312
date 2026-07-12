import { describe, expect, it } from "vitest";
import { suggestionLabels } from "@/lib/i18n/he";
import { suggestFor } from "./suggestions";

describe("suggestions map", () => {
  it("the six seeded exception types get six DIFFERENT recommended actions", () => {
    const six = [
      { status: "SOFT_HELD", currentAction: "CHOOSE_DATE", holdExpired: true }, // expired hold
      { incidentKind: "HALF_DAY_FREE" }, // collapsed half-day
      { status: "BRIEF_PENDING", currentAction: "WRITE_BRIEF" }, // late brief
      { status: "READY", currentAction: "CONFIRM_CLIENT_CONTACT" }, // unconfirmed T-1
      { status: "AWAITING_DELIVERY", currentAction: "UPLOAD_DELIVERABLES" }, // overdue deliverable
      { status: "OPTIONS_PROPOSED", currentAction: "REVIEW_REQUEST" }, // stuck 3 days
    ];
    const keys = six.map((row) => suggestFor(row).key);
    expect(new Set(keys).size).toBe(6);
    expect(keys).toEqual([
      "RELEASE_EXPIRED_HOLD",
      "RESOLVE_HALF_DAY",
      "REMIND_BRIEF_OWNER",
      "MARK_T1_CONFIRMED",
      "REMIND_SUPPLIER_DELIVERABLES",
      "APPROVE_MATCH",
    ]);
  });

  it("eligibility holds route to GRANT_EXCEPTION", () => {
    expect(suggestFor({ status: "PENDING_MATCH", currentAction: "GRANT_EXCEPTION" }).key).toBe(
      "GRANT_EXCEPTION",
    );
  });

  it("a LIVE hold gets a reminder, never a release — unknown liveness is treated as live", () => {
    expect(suggestFor({ status: "SOFT_HELD", currentAction: "CHOOSE_DATE", holdExpired: false })).toEqual({
      key: "REMIND_CLIENT_DATE",
      kind: "notify",
    });
    expect(suggestFor({ status: "SOFT_HELD", currentAction: "CHOOSE_DATE" }).key).toBe(
      "REMIND_CLIENT_DATE",
    );
    expect(suggestFor({ status: "SOFT_HELD", currentAction: "CHOOSE_DATE", holdExpired: null }).key).toBe(
      "REMIND_CLIENT_DATE",
    );
    expect(suggestFor({ status: "SOFT_HELD", currentAction: "CHOOSE_DATE", holdExpired: true }).key).toBe(
      "RELEASE_EXPIRED_HOLD",
    );
  });

  it("solo-day decision incidents keep the decision with Noam", () => {
    const s = suggestFor({ incidentKind: "SOLO_DAY_DECISION" });
    expect(s.key).toBe("RESOLVE_SOLO_DECISION");
    expect(s.kind).toBe("resolve_incident");
  });

  it("unknown combinations fall back to opening the request", () => {
    expect(suggestFor({ status: "SHOT", currentAction: "NONE" }).key).toBe("OPEN_REQUEST");
    expect(suggestFor({})).toEqual({ key: "OPEN_REQUEST", kind: "navigate" });
  });

  it("every suggestion key has Hebrew labels", () => {
    for (const row of [
      { status: "MISSING_INFO", currentAction: "COMPLETE_REQUEST" },
      { status: "PENDING_MATCH", currentAction: "FIND_SUPPLIER" },
      { status: "DELIVERED", currentAction: "FORWARD_DELIVERABLES" },
      { status: "READY", currentAction: "RUN_SHOOT" },
      { incidentKind: "CLIENT_CANCEL" },
    ]) {
      const s = suggestFor(row);
      expect(suggestionLabels[s.key].button.length).toBeGreaterThan(0);
    }
  });
});
