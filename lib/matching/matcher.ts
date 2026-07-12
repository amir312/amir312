/**
 * THE matcher — greedy with scoring. No solver, no PostGIS, on purpose:
 * dozens of requests a month, and Noam must be able to interrogate every
 * recommendation ("למה שיבצת ככה?") — so every candidate carries a Hebrew
 * reason, and the arithmetic is legible.
 *
 * PURE module: data in, candidates out. Persistence lives in
 * lib/services/matching.ts. The system proposes; Noam approves. Always.
 *
 * Score (from the spec, weights fixed):
 *   40 × paired + 25 × urgency + 20 × (1 − normalized_travel) + 15 × client_inflexibility
 */
import { regionLabel, matcherReasons } from "@/lib/i18n/he";
import { Rules, RULE } from "@/lib/workflow/rules";
import { estimateTravelMinutes, type LatLng } from "./geo";

export interface MatchableRequest {
  id: string;
  clientId: string;
  clientName: string;
  shootType: "STILLS" | "VIDEO" | "CONTENT_CREATION";
  regionCode: string | null;
  latLng: LatLng | null;
  /** [{from,to}] ISO dates — the client's stated windows from intake. */
  windows: Array<{ from?: string | null; to?: string | null }>;
  flexibility: "HIGH" | "MEDIUM" | "LOW" | null;
  submittedAt: Date;
}

export interface MatchableSupplier {
  id: string;
  name: string;
  capabilities: string[];
  serviceRegions: string[];
  acceptsSoloHalfDay: boolean;
  baseLatLng: LatLng | null;
}

export interface OpenWindow {
  supplierId: string;
  date: string; // ISO
  start: string; // HH:MM
  end: string;
}

export interface Candidate {
  requestId: string;
  supplierId: string;
  supplierName: string;
  date: string;
  start: string;
  end: string;
  /** Present when this candidate is one half of a proposed paired day. */
  pairedWithRequestId: string | null;
  travelMinutes: number | null;
  score: number;
  reason: string;
}

export interface MatchOutcome {
  /** Candidate options per request id, best first. */
  byRequest: Map<string, Candidate[]>;
}

function fitsWindows(req: MatchableRequest, date: string): boolean {
  if (req.windows.length === 0) return true;
  return req.windows.some((w) => {
    const from = w.from ?? "0000-01-01";
    const to = w.to ?? "9999-12-31";
    return date >= from && date <= to;
  });
}

function urgencyOf(req: MatchableRequest, now: Date, horizonDays: number): number {
  const waitedDays = (now.getTime() - req.submittedAt.getTime()) / 86_400_000;
  return Math.max(0, Math.min(1, waitedDays / horizonDays));
}

function inflexibilityOf(req: MatchableRequest): number {
  if (req.flexibility === "LOW") return 1;
  if (req.flexibility === "MEDIUM") return 0.5;
  return 0;
}

function daysWaited(req: MatchableRequest, now: Date): number {
  return Math.floor((now.getTime() - req.submittedAt.getTime()) / 86_400_000);
}

interface ScoreInput {
  paired: boolean;
  urgency: number;
  normalizedTravel: number; // 0 (next door) … 1 (at the cap)
  inflexibility: number;
}

export function scoreOf(s: ScoreInput): number {
  return (
    40 * (s.paired ? 1 : 0) +
    25 * s.urgency +
    20 * (1 - s.normalizedTravel) +
    15 * s.inflexibility
  );
}

export function runMatcher(
  requests: MatchableRequest[],
  suppliers: MatchableSupplier[],
  openWindows: OpenWindow[],
  rules: Rules,
  now: Date,
): MatchOutcome {
  const maxTravelMin = rules.int(RULE.maxPairingTravelMinutes);
  const optionsPerClient = rules.int(RULE.slotOptionsPerClient);
  const urgencyHorizon = rules.int(RULE.urgencyHorizonDays);
  const travelKmh = rules.int(RULE.travelEstimateKmh);

  // supplier|date → windows, earliest first (so pairs land morning+afternoon).
  const dayKey = (sid: string, date: string) => `${sid}|${date}`;
  const windowsByDay = new Map<string, OpenWindow[]>();
  for (const w of openWindows) {
    const k = dayKey(w.supplierId, w.date);
    if (!windowsByDay.has(k)) windowsByDay.set(k, []);
    windowsByDay.get(k)!.push(w);
  }
  for (const list of windowsByDay.values()) list.sort((a, b) => a.start.localeCompare(b.start));

  function supplierServes(s: MatchableSupplier, req: MatchableRequest): boolean {
    return (
      s.capabilities.includes(req.shootType) &&
      (req.regionCode === null || s.serviceRegions.includes(req.regionCode))
    );
  }

  function travelBetween(a: MatchableRequest, b: MatchableRequest): number | null {
    if (!a.latLng || !b.latLng) {
      // Region fallback: same region counts as within the cap, unknown pairs don't pair.
      return a.regionCode !== null && a.regionCode === b.regionCode ? maxTravelMin / 2 : null;
    }
    return estimateTravelMinutes(a.latLng, b.latLng, travelKmh);
  }

  const byRequest = new Map<string, Candidate[]>();
  const add = (c: Candidate) => {
    if (!byRequest.has(c.requestId)) byRequest.set(c.requestId, []);
    byRequest.get(c.requestId)!.push(c);
  };

  // ── 1. paired candidates — the commercial core ─────────────────────────
  for (let i = 0; i < requests.length; i++) {
    for (let j = i + 1; j < requests.length; j++) {
      const a = requests[i];
      const b = requests[j];
      if (a.shootType !== b.shootType) continue; // one photographer, one craft per day
      const travel = travelBetween(a, b);
      if (travel === null || travel > maxTravelMin) continue;

      for (const s of suppliers) {
        if (!supplierServes(s, a) || !supplierServes(s, b)) continue;
        for (const [k, windows] of windowsByDay) {
          if (!k.startsWith(`${s.id}|`)) continue;
          if (windows.length < 2) continue;
          const date = windows[0].date;
          if (!fitsWindows(a, date) || !fitsWindows(b, date)) continue;

          const normTravel = Math.min(1, travel / maxTravelMin);
          for (const [first, second] of [
            [a, b],
            [b, a],
          ] as const) {
            const win = first === a ? windows[0] : windows[1];
            const score = scoreOf({
              paired: true,
              urgency: urgencyOf(first, now, urgencyHorizon),
              normalizedTravel: normTravel,
              inflexibility: inflexibilityOf(first),
            });
            add({
              requestId: first.id,
              supplierId: s.id,
              supplierName: s.name,
              date,
              start: win.start,
              end: win.end,
              pairedWithRequestId: second.id,
              travelMinutes: travel,
              score,
              reason: matcherReasons.paired({
                partnerName: second.clientName,
                travelMinutes: travel,
                supplierName: s.name,
                region: regionLabel(first.regionCode),
                daysWaited: daysWaited(first, now),
              }),
            });
          }
        }
      }
    }
  }

  // ── 2. solo candidates (suppliers that accept a lone half day) ─────────
  for (const req of requests) {
    for (const s of suppliers) {
      if (!s.acceptsSoloHalfDay) continue;
      if (!supplierServes(s, req)) continue;
      for (const [k, windows] of windowsByDay) {
        if (!k.startsWith(`${s.id}|`)) continue;
        const date = windows[0].date;
        if (!fitsWindows(req, date)) continue;
        const travel =
          req.latLng && s.baseLatLng ? estimateTravelMinutes(s.baseLatLng, req.latLng, travelKmh) : null;
        if (travel !== null && travel > maxTravelMin * 2) continue; // sanity cap for solo
        const normTravel = travel === null ? 0.5 : Math.min(1, travel / maxTravelMin);
        const win = windows[0];
        add({
          requestId: req.id,
          supplierId: s.id,
          supplierName: s.name,
          date,
          start: win.start,
          end: win.end,
          pairedWithRequestId: null,
          travelMinutes: travel,
          score: scoreOf({
            paired: false,
            urgency: urgencyOf(req, now, urgencyHorizon),
            normalizedTravel: normTravel,
            inflexibility: inflexibilityOf(req),
          }),
          reason: matcherReasons.solo({
            supplierName: s.name,
            date,
            region: regionLabel(req.regionCode),
            daysWaited: daysWaited(req, now),
          }),
        });
      }
    }
  }

  // Best first, capped by the rules-defined option count, one option per
  // supplier-day per request (no duplicate windows of the same day).
  for (const [reqId, list] of byRequest) {
    list.sort((x, y) => y.score - x.score);
    const seenDay = new Set<string>();
    const pruned: Candidate[] = [];
    for (const c of list) {
      const k = dayKey(c.supplierId, c.date);
      if (seenDay.has(k)) continue;
      seenDay.add(k);
      pruned.push(c);
      if (pruned.length >= optionsPerClient) break;
    }
    byRequest.set(reqId, pruned);
  }

  return { byRequest };
}
