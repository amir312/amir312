/** Pure matcher tests: filters, the spec's scoring formula, Hebrew reasons. */
import { describe, expect, it } from "vitest";
import { Rules } from "@/lib/workflow/rules";
import { haversineKm } from "./geo";
import {
  runMatcher,
  scoreOf,
  type MatchableRequest,
  type MatchableSupplier,
  type OpenWindow,
} from "./matcher";

const rules = new Rules({
  max_pairing_travel_minutes: 30,
  slot_options_per_client: 3,
  urgency_horizon_days: 14,
  travel_estimate_kmh: 50,
});

const NOW = new Date("2026-07-12T09:00:00Z");
const DATE = "2026-07-20";

// Ra'anana and Kfar Saba — ~5km apart. Haifa is ~70km away.
const RAANANA = { lat: 32.1848, lng: 34.8713 };
const KFAR_SABA = { lat: 32.175, lng: 34.9071 };
const HAIFA = { lat: 32.794, lng: 34.9896 };

function req(id: string, over: Partial<MatchableRequest> = {}): MatchableRequest {
  return {
    id,
    clientId: `client-${id}`,
    clientName: `לקוח ${id}`,
    shootType: "STILLS",
    regionCode: "SHARON",
    latLng: RAANANA,
    windows: [{ from: "2026-07-13", to: "2026-07-31" }],
    flexibility: "MEDIUM",
    submittedAt: new Date(NOW.getTime() - 7 * 86_400_000),
    ...over,
  };
}

function supplier(id: string, over: Partial<MatchableSupplier> = {}): MatchableSupplier {
  return {
    id,
    name: `צלם ${id}`,
    capabilities: ["STILLS"],
    serviceRegions: ["SHARON"],
    acceptsSoloHalfDay: true,
    baseLatLng: RAANANA,
    ...over,
  };
}

function windows(supplierId: string, date = DATE): OpenWindow[] {
  return [
    { supplierId, date, start: "08:00", end: "12:00" },
    { supplierId, date, start: "13:00", end: "17:00" },
  ];
}

describe("scoring", () => {
  it("implements the spec formula exactly", () => {
    expect(scoreOf({ paired: true, urgency: 1, normalizedTravel: 0, inflexibility: 1 })).toBe(100);
    expect(scoreOf({ paired: false, urgency: 0, normalizedTravel: 1, inflexibility: 0 })).toBe(0);
    expect(scoreOf({ paired: true, urgency: 0.5, normalizedTravel: 0.5, inflexibility: 0.5 })).toBe(
      40 + 12.5 + 10 + 7.5,
    );
  });

  it("a paired candidate always beats the equivalent solo (the 40-point pairing weight)", () => {
    const out = runMatcher([req("a"), req("b", { latLng: KFAR_SABA })], [supplier("s1")], windows("s1"), rules, NOW);
    const a = out.byRequest.get("a")!;
    expect(a[0].pairedWithRequestId).toBe("b");
    expect(a[0].score).toBeGreaterThan(40);
  });
});

describe("hard filters", () => {
  it("no pairing beyond max_pairing_travel_minutes", () => {
    // Haifa is ~70km from Ra'anana → ~84 driving minutes >> 30.
    expect(haversineKm(RAANANA, HAIFA)).toBeGreaterThan(60);
    const out = runMatcher(
      [req("a"), req("b", { latLng: HAIFA, regionCode: "SHARON" })],
      [supplier("s1")],
      windows("s1"),
      rules,
      NOW,
    );
    for (const c of out.byRequest.get("a") ?? []) {
      expect(c.pairedWithRequestId).toBeNull();
    }
  });

  it("capability and region are absolute", () => {
    const out = runMatcher(
      [req("a", { shootType: "VIDEO" })],
      [supplier("s1", { capabilities: ["STILLS"] }), supplier("s2", { capabilities: ["VIDEO"], serviceRegions: ["HAIFA"] })],
      [...windows("s1"), ...windows("s2")],
      rules,
      NOW,
    );
    expect(out.byRequest.get("a") ?? []).toEqual([]);
  });

  it("the client's stated windows are respected", () => {
    const out = runMatcher(
      [req("a", { windows: [{ from: "2026-08-01", to: "2026-08-15" }] })],
      [supplier("s1")],
      windows("s1"), // July date
      rules,
      NOW,
    );
    expect(out.byRequest.get("a") ?? []).toEqual([]);
  });

  it("full-day-only suppliers are never proposed a solo half day", () => {
    const out = runMatcher([req("a")], [supplier("s1", { acceptsSoloHalfDay: false })], windows("s1"), rules, NOW);
    expect(out.byRequest.get("a") ?? []).toEqual([]);
    // …but a PAIR on that supplier is fine.
    const paired = runMatcher(
      [req("a"), req("b", { latLng: KFAR_SABA })],
      [supplier("s1", { acceptsSoloHalfDay: false })],
      windows("s1"),
      rules,
      NOW,
    );
    expect(paired.byRequest.get("a")![0].pairedWithRequestId).toBe("b");
  });

  it("pairing requires two open windows on the same day", () => {
    const out = runMatcher(
      [req("a"), req("b", { latLng: KFAR_SABA })],
      [supplier("s1")],
      [{ supplierId: "s1", date: DATE, start: "08:00", end: "12:00" }],
      rules,
      NOW,
    );
    for (const c of out.byRequest.get("a") ?? []) expect(c.pairedWithRequestId).toBeNull();
  });

  it("requests without coordinates pair via same-region fallback only", () => {
    const out = runMatcher(
      [req("a", { latLng: null }), req("b", { latLng: null })],
      [supplier("s1")],
      windows("s1"),
      rules,
      NOW,
    );
    expect(out.byRequest.get("a")![0].pairedWithRequestId).toBe("b");
    const cross = runMatcher(
      [req("a", { latLng: null }), req("b", { latLng: null, regionCode: "TLV" })],
      [supplier("s1", { serviceRegions: ["SHARON", "TLV"] })],
      windows("s1"),
      rules,
      NOW,
    );
    for (const c of cross.byRequest.get("a") ?? []) expect(c.pairedWithRequestId).toBeNull();
  });
});

describe("output shape", () => {
  it("every candidate carries a Hebrew reason Noam can interrogate", () => {
    const out = runMatcher([req("a"), req("b", { latLng: KFAR_SABA })], [supplier("s1")], windows("s1"), rules, NOW);
    const top = out.byRequest.get("a")![0];
    expect(top.reason).toContain("לקוח b"); // the partner, by name
    expect(top.reason).toContain("דק' נסיעה");
    expect(top.reason).toContain("השרון"); // region label, never the code
    expect(top.reason).not.toContain("SHARON");
  });

  it("caps options per request at rules.slot_options_per_client, one per supplier-day", () => {
    const sups = [supplier("s1"), supplier("s2"), supplier("s3"), supplier("s4"), supplier("s5")];
    const wins = sups.flatMap((s) => windows(s.id));
    const out = runMatcher([req("a")], sups, wins, rules, NOW);
    expect(out.byRequest.get("a")!.length).toBeLessThanOrEqual(3);
    const days = out.byRequest.get("a")!.map((c) => `${c.supplierId}|${c.date}`);
    expect(new Set(days).size).toBe(days.length);
  });

  it("urgency rises with waiting time (older request scores higher)", () => {
    // Two separate runs so the two requests cannot pair with each other.
    const fresh = runMatcher([req("fresh", { submittedAt: NOW })], [supplier("s1")], windows("s1"), rules, NOW);
    const old = runMatcher(
      [req("old", { submittedAt: new Date(NOW.getTime() - 14 * 86_400_000) })],
      [supplier("s1")],
      windows("s1"),
      rules,
      NOW,
    );
    expect(old.byRequest.get("old")![0].score).toBeGreaterThan(fresh.byRequest.get("fresh")![0].score);
  });
});
