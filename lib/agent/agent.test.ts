/**
 * CLAUDE.md invariant 1, proven against real Postgres:
 *  - every tool is readonly XOR requiresApproval (no third kind),
 *  - readonly tools write NOTHING (row-count snapshot before/after),
 *  - the agent loop NEVER executes an approval tool — it renders a preview
 *    card and tells the model the action is pending,
 *  - the approve() path is the only writer, attributed to the human.
 * The model is a deterministic fake — no network, no API key.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { sql } from "drizzle-orm";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as s from "@/db/schema";
import { seedClient, seedSupplier, seedUser } from "@/db/test/fixtures";
import { createTestDb, type TestDb } from "@/db/test/harness";

let t: TestDb;
let tools: typeof import("./tools");
let run: typeof import("./run");
let matching: typeof import("@/lib/services/matching");

let sm: Awaited<ReturnType<typeof seedUser>>;
let noam: Awaited<ReturnType<typeof seedUser>>;
let clientA: Awaited<ReturnType<typeof seedClient>>;
let supplier: Awaited<ReturnType<typeof seedSupplier>>;
let pendingRequestId: string;

const HOUR = 3_600_000;

function futureDate(daysAhead: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(
    new Date(Date.now() + daysAhead * 86_400_000),
  );
}

/** Row counts across every state-bearing table — the "nothing was written" proof. */
async function stateSnapshot(): Promise<Record<string, number>> {
  const tables = [
    "shoot_requests",
    "events",
    "slot_proposals",
    "supplier_days",
    "shoot_slots",
    "supplier_availability",
    "notifications",
    "access_tokens",
    "entitlement_events",
    "incidents",
    "briefs",
    "deliverables",
  ];
  const out: Record<string, number> = {};
  for (const table of tables) {
    const rows = await t.db.execute(sql.raw(`select count(*)::int as n from ${table}`));
    out[table] = (rows as unknown as Array<{ n: number }>)[0].n;
  }
  return out;
}

beforeAll(async () => {
  t = await createTestDb();
  process.env.DATABASE_URL = t.url;
  process.env.APP_ORIGIN = "https://ops.test";
  tools = await import("./tools");
  run = await import("./run");
  matching = await import("@/lib/services/matching");

  sm = await seedUser(t.db);
  noam = await seedUser(t.db, { role: "COORDINATOR", name: "נועם" });
  clientA = await seedClient(t.db, {
    name: "מאפיית הסוכן",
    lat: 32.18,
    lng: 34.87,
    isSocialManaged: true,
    socialManagerId: sm.id,
  });
  supplier = await seedSupplier(t.db, { name: "צלם הסוכן", baseLat: 32.18, baseLng: 34.88 });
  for (const [start, end] of [
    ["08:00", "12:00"],
    ["13:00", "17:00"],
  ] as const) {
    await t.db.insert(s.supplierAvailability).values({
      supplierId: supplier.id,
      date: futureDate(7),
      startTime: start,
      endTime: end,
      status: "AVAILABLE",
    });
  }
  await t.db.insert(s.entitlementEvents).values({
    clientId: clientA.id,
    kind: "GRANT",
    shootType: "STILLS",
    delta: 1,
    source: "LEGACY_PACKAGE",
  });
  const { seedRequest } = await import("@/db/test/fixtures");
  const req = await seedRequest(t.db, clientA.id, sm.id, {
    status: "PENDING_MATCH",
    currentOwnerType: "SYSTEM",
    currentAction: "FIND_SUPPLIER",
    ownerSince: new Date(Date.now() - 3 * 24 * HOUR), // stuck long enough to be an exception
    actionDueAt: new Date(Date.now() - 24 * HOUR),
    escalateAt: new Date(Date.now() + 24 * HOUR),
    clientWindows: [{ from: futureDate(1), to: futureDate(30) }],
    eligibility: "ELIGIBLE",
  });
  pendingRequestId = req.id;
  await t.db.insert(s.events).values({
    entityType: "shoot_request",
    entityId: req.id,
    kind: "REQUEST_SUBMITTED",
    actorType: "SOCIAL_MANAGER",
    actorId: sm.id,
    summary: "הבקשה הוגשה ונכנסה לתור השיבוץ",
  });
});

afterAll(async () => {
  await t.destroy();
});

describe("the registry invariant — readonly XOR requiresApproval", () => {
  it("every tool declares exactly one execution mode, unique names, model-usable schemas", async () => {
    const { z } = await import("zod");
    expect(tools.AGENT_TOOLS.length).toBeGreaterThanOrEqual(8);
    const names = new Set<string>();
    for (const tool of tools.AGENT_TOOLS) {
      const ro = tools.isReadonlyTool(tool);
      const ap = tools.isApprovalTool(tool);
      expect(ro !== ap, `${tool.name} must be readonly XOR requiresApproval`).toBe(true);
      expect(tool.description.length).toBeGreaterThan(20);
      expect(names.has(tool.name)).toBe(false);
      names.add(tool.name);
      // the schema must convert to JSON Schema (what the API receives)
      const json = z.toJSONSchema(tool.schema) as { type?: string };
      expect(json.type).toBe("object");
    }
    // the exact surface the spec names
    for (const required of [
      "get_exceptions",
      "find_pairing_candidates",
      "get_supplier_availability",
      "summarize_timeline",
      "get_overdue_deliverables",
      "draft_message",
      "propose_match",
      "create_request_from_text",
    ]) {
      expect(names.has(required), required).toBe(true);
    }
  });
});

describe("read-only tools read and NEVER write", () => {
  it("all five readonly tools return data while every state table stays byte-identical in count", async () => {
    const before = await stateSnapshot();

    const exceptions = (await execTool("get_exceptions", {})) as Array<{ requestId: string }>;
    expect(exceptions.some((e) => e.requestId === pendingRequestId)).toBe(true);

    const candidates = (await execTool("find_pairing_candidates", {
      requestId: pendingRequestId,
    })) as { candidates: Array<{ supplierName: string }> };
    expect(candidates.candidates.length).toBeGreaterThan(0);
    expect(candidates.candidates[0].supplierName).toBe("צלם הסוכן");

    const availability = (await execTool("get_supplier_availability", {
      supplierName: "צלם הסוכן",
    })) as Array<{ date: string }>;
    expect(availability.length).toBe(2);

    const timeline = (await execTool("summarize_timeline", {
      requestId: pendingRequestId,
    })) as { client: string; timeline: unknown[] };
    expect(timeline.client).toBe("מאפיית הסוכן");
    expect(timeline.timeline.length).toBeGreaterThan(0);

    const overdue = await execTool("get_overdue_deliverables", {});
    expect(Array.isArray(overdue)).toBe(true);

    expect(await stateSnapshot()).toEqual(before); // THE invariant
  });
});

async function execTool(name: string, input: unknown): Promise<unknown> {
  const tool = tools.toolByName(name);
  if (!tool || !tools.isReadonlyTool(tool)) throw new Error(`${name} is not readonly`);
  return tool.execute(tool.schema.parse(input));
}

// ─────────────────────────────────────────────────────────────
// The loop with a deterministic fake model
// ─────────────────────────────────────────────────────────────

function fakeMessage(content: Anthropic.ContentBlock[], stopReason: Anthropic.Message["stop_reason"]): Anthropic.Message {
  return {
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model: "fake",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 } as Anthropic.Usage,
  } as Anthropic.Message;
}

function textBlock(text: string): Anthropic.TextBlock {
  return { type: "text", text, citations: null } as Anthropic.TextBlock;
}

function toolUseBlock(name: string, input: unknown): Anthropic.ToolUseBlock {
  return { type: "tool_use", id: `toolu_${name}`, name, input } as Anthropic.ToolUseBlock;
}

/** A scripted model: returns the queued responses in order, records requests. */
function scriptedClient(responses: Anthropic.Message[]) {
  const calls: Anthropic.MessageCreateParams[] = [];
  return {
    calls,
    client: {
      async create(params: Anthropic.MessageCreateParams) {
        calls.push(params);
        const next = responses.shift();
        if (!next) throw new Error("fake model ran out of responses");
        return next;
      },
    },
  };
}

describe("the agent loop", () => {
  it("executes a READONLY tool and feeds its result back to the model", async () => {
    const scripted = scriptedClient([
      fakeMessage([toolUseBlock("get_exceptions", {})], "tool_use"),
      fakeMessage([textBlock("יש בקשה אחת תקועה: מאפיית הסוכן.")], "end_turn"),
    ]);

    const result = await run.runAgentTurn([{ role: "user", content: "מה תקוע?" }], {
      client: scripted.client,
    });

    expect(result.reply).toContain("מאפיית הסוכן");
    expect(result.pendingActions).toEqual([]);
    expect(result.toolCalls).toEqual([{ name: "get_exceptions", readonly: true }]);

    // the second request carried the tool result with REAL data
    const second = scripted.calls[1];
    const lastMsg = second.messages[second.messages.length - 1];
    const resultBlock = (lastMsg.content as Anthropic.ToolResultBlockParam[])[0];
    expect(resultBlock.type).toBe("tool_result");
    expect(String(resultBlock.content)).toContain(pendingRequestId);
  });

  it("NEVER executes an approval tool: preview card out, nothing sent, model told it is pending", async () => {
    const before = await stateSnapshot();
    const draftInput = {
      recipientKind: "SUPPLIER",
      recipientName: "צלם הסוכן",
      body: "תזכורת ידידותית: מחכים לחומרים מהצילום של מאפיית הסוכן.",
    };
    const scripted = scriptedClient([
      fakeMessage([toolUseBlock("draft_message", draftInput)], "tool_use"),
      fakeMessage([textBlock("ניסחתי הודעה — ממתינה לאישורך.")], "end_turn"),
    ]);

    const result = await run.runAgentTurn(
      [{ role: "user", content: "שלחי תזכורת לצלם" }],
      { client: scripted.client },
    );

    // a preview card, with the draft text Noam will read
    expect(result.pendingActions).toHaveLength(1);
    expect(result.pendingActions[0].toolName).toBe("draft_message");
    expect(result.pendingActions[0].details.join(" ")).toContain("תזכורת ידידותית");

    // the model was TOLD it did not happen
    const second = scripted.calls[1];
    const lastMsg = second.messages[second.messages.length - 1];
    const resultBlock = (lastMsg.content as Anthropic.ToolResultBlockParam[])[0];
    expect(String(resultBlock.content)).toContain("PENDING_APPROVAL");

    // and NOTHING was written — no notification, no event, no anything
    expect(await stateSnapshot()).toEqual(before);
  });

  it("stops on refusal with a safe Hebrew reply", async () => {
    const scripted = scriptedClient([fakeMessage([], "refusal")]);
    const result = await run.runAgentTurn([{ role: "user", content: "..." }], {
      client: scripted.client,
    });
    expect(result.reply.length).toBeGreaterThan(0);
    expect(result.pendingActions).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// The approval path — the ONLY writer, attributed to the human
// ─────────────────────────────────────────────────────────────

describe("approve()", () => {
  it("draft_message approve sends the notification and records the timeline event; double-approve cannot double-send", async () => {
    const tool = tools.toolByName("draft_message");
    if (!tool || !tools.isApprovalTool(tool)) throw new Error("missing tool");
    const input = tool.schema.parse({
      recipientKind: "SUPPLIER",
      recipientName: "צלם הסוכן",
      body: "בדיקת אישור: נא להעלות את התוצרים עד מחר.",
      requestId: pendingRequestId,
    });

    const message = await tool.approve(input, noam);
    expect(message.length).toBeGreaterThan(0);

    const notes = await t.db
      .select()
      .from(s.notifications)
      .where(eq(s.notifications.template, "agent_drafted_message"));
    expect(notes).toHaveLength(1);
    expect(JSON.stringify(notes[0].payload)).toContain("בדיקת אישור");

    const evts = await t.db
      .select()
      .from(s.events)
      .where(and(eq(s.events.entityId, pendingRequestId), eq(s.events.kind, "MESSAGE_SENT")));
    expect(evts).toHaveLength(1);
    expect(evts[0].actorType).toBe("COORDINATOR");
    expect(evts[0].actorId).toBe(noam.id); // attributed to the human who clicked

    // double-click: same content, same idempotency key → still ONE send
    await tool.approve(input, noam);
    const notesAfter = await t.db
      .select()
      .from(s.notifications)
      .where(eq(s.notifications.template, "agent_drafted_message"));
    expect(notesAfter).toHaveLength(1);
  });

  it("propose_match: preview persists NOTHING; approve runs the real matcher", async () => {
    const tool = tools.toolByName("propose_match");
    if (!tool || !tools.isApprovalTool(tool)) throw new Error("missing tool");
    const input = tool.schema.parse({ requestId: pendingRequestId });

    const before = await stateSnapshot();
    const preview = await tool.preview(input);
    expect(preview.details.length).toBeGreaterThan(0);
    expect(await stateSnapshot()).toEqual(before); // preview is read-only

    await tool.approve(input, noam);
    const proposals = await t.db
      .select()
      .from(s.slotProposals)
      .where(eq(s.slotProposals.shootRequestId, pendingRequestId));
    expect(proposals.length).toBeGreaterThan(0); // approval wrote, via the service
    const [row] = await t.db
      .select({ status: s.shootRequests.status })
      .from(s.shootRequests)
      .where(eq(s.shootRequests.id, pendingRequestId));
    expect(row.status).toBe("OPTIONS_PROPOSED");
  });

  it("create_request_from_text: approve creates a REAL request through intake; unknown client is a Hebrew error", async () => {
    const tool = tools.toolByName("create_request_from_text");
    if (!tool || !tools.isApprovalTool(tool)) throw new Error("missing tool");

    await t.db.insert(s.entitlementEvents).values({
      clientId: clientA.id,
      kind: "GRANT",
      shootType: "VIDEO",
      delta: 1,
      source: "SEPARATE_PURCHASE",
    });
    const input = tool.schema.parse({
      clientName: "מאפיית הסוכן",
      shootType: "VIDEO",
      purpose: "סרטון קצר לרשתות על מבצע החורף",
      windowFrom: futureDate(3),
      windowTo: futureDate(21),
    });
    const message = await tool.approve(input, noam);
    expect(message.length).toBeGreaterThan(0);

    const created = await t.db
      .select()
      .from(s.shootRequests)
      .where(and(eq(s.shootRequests.clientId, clientA.id), eq(s.shootRequests.shootType, "VIDEO")));
    expect(created).toHaveLength(1);
    expect(["PENDING_MATCH", "MISSING_INFO"]).toContain(created[0].status);
    expect(created[0].createdBy).toBe(noam.id);

    await expect(
      tool.approve(tool.schema.parse({ clientName: "לקוח שלא קיים", shootType: "STILLS" }), noam),
    ).rejects.toThrow(/לא נמצא לקוח/);
  });
});
