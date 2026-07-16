/**
 * The agent loop. A deliberate MANUAL tool loop (not the SDK tool runner):
 * approval-required tools must never execute here — they yield a PREVIEW and
 * a pending action for Noam's approve button — and tests inject a fake model
 * client to drive the loop deterministically without network or beta deps.
 *
 * The LLM never writes state (CLAUDE.md invariant 1): readonly tools execute
 * against the service layer; requiresApproval tools return "awaiting approval"
 * as their tool_result and the real execution happens in the approval server
 * action, attributed to the human who clicked.
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { agentT } from "@/lib/i18n/he";
import { signPendingAction } from "./approval";
import { AGENT_TOOLS, isApprovalTool, isReadonlyTool, toolByName } from "./tools";

export const AGENT_MODEL = process.env.AGENT_MODEL ?? "claude-opus-4-8";
const MAX_LOOP_ITERATIONS = 8;

/** The minimal slice of the Messages API the loop needs — injectable for tests. */
export interface ModelClient {
  create(params: Anthropic.MessageCreateParams): Promise<Anthropic.Message>;
}

export function hasAgentApiKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function realClient(): ModelClient {
  const anthropic = new Anthropic();
  return { create: (params) => anthropic.messages.create(params) as Promise<Anthropic.Message> };
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface PendingAction {
  /** Client-side handle for React keys. */
  id: string;
  toolName: string;
  /** The validated tool input — re-validated server-side on approval. */
  input: unknown;
  /** HMAC binding this exact (toolName, input) to the preview that was shown.
   *  The approval endpoint executes NOTHING without a verifying signature. */
  signature: string;
  title: string;
  details: string[];
}

export interface AgentTurnResult {
  reply: string;
  pendingActions: PendingAction[];
  /** What the agent looked at — surfaced in the UI so the loop is inspectable. */
  toolCalls: Array<{ name: string; readonly: boolean }>;
}

const SYSTEM_PROMPT = `You are the operations assistant for ShootOps — Zap Digital's shoot-day coordination system. You work for נועם (Noam), the coordinator. Always answer in Hebrew, concise and operational.

You can READ everything through your read-only tools: the exceptions queue, pairing candidates, supplier availability, request timelines, overdue deliverables. Use them before answering questions about system state — never guess.

You can PROPOSE actions (draft_message, propose_match, create_request_from_text) but you cannot perform them: each one is shown to Noam as a preview card and happens only if she approves. Never claim an action was performed — say it awaits her approval. For minor phrasing choices in drafts, decide yourself; for anything that changes state, the approval card IS the ask.

Dates are ISO (YYYY-MM-DD); the business runs on Asia/Jerusalem time. Refer to people by name, never by id. Keep answers short: what matters, who owns it, and the deadline.`;

function toApiTools(): Anthropic.Tool[] {
  return AGENT_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: z.toJSONSchema(tool.schema) as Anthropic.Tool.InputSchema,
  }));
}

/**
 * Run one user turn: loop over tool calls until the model stops. Readonly
 * tools execute; approval tools preview. Returns the final Hebrew reply plus
 * any pending approval cards.
 */
export async function runAgentTurn(
  history: ChatTurn[],
  opts: { client?: ModelClient; model?: string } = {},
): Promise<AgentTurnResult> {
  const client = opts.client ?? realClient();
  const model = opts.model ?? AGENT_MODEL;

  const messages: Anthropic.MessageParam[] = history.map((t) => ({
    role: t.role,
    content: t.content,
  }));

  const pendingActions: PendingAction[] = [];
  const toolCalls: AgentTurnResult["toolCalls"] = [];
  let reply = "";
  let lastStopReason: Anthropic.Message["stop_reason"] = null;

  for (let i = 0; i < MAX_LOOP_ITERATIONS; i++) {
    const response = await client.create({
      model,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      thinking: { type: "adaptive" },
      tools: toApiTools(),
      messages,
    });
    lastStopReason = response.stop_reason;

    if (response.stop_reason === "refusal") {
      return { reply: agentT.refused, pendingActions, toolCalls };
    }

    const textParts = response.content.filter((b) => b.type === "text").map((b) => b.text);
    if (textParts.length > 0) reply = textParts.join("\n");

    if (response.stop_reason !== "tool_use") break;

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    messages.push({ role: "assistant", content: response.content });

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      results.push(await runOneTool(use, pendingActions, toolCalls));
    }
    messages.push({ role: "user", content: results });
  }

  // Cut-offs must be VISIBLE, never silent: an exhausted tool budget or a
  // max_tokens truncation reads very differently from a finished answer.
  let finalReply = reply || agentT.emptyReply;
  if (lastStopReason === "tool_use") finalReply = `${finalReply}\n\n${agentT.loopBudgetNote}`;
  if (lastStopReason === "max_tokens") finalReply = `${finalReply}\n\n${agentT.truncatedNote}`;
  return { reply: finalReply, pendingActions, toolCalls };
}

async function runOneTool(
  use: Anthropic.ToolUseBlock,
  pendingActions: PendingAction[],
  toolCalls: AgentTurnResult["toolCalls"],
): Promise<Anthropic.ToolResultBlockParam> {
  const tool = toolByName(use.name);
  if (!tool) {
    return { type: "tool_result", tool_use_id: use.id, content: `unknown tool: ${use.name}`, is_error: true };
  }
  const parsed = tool.schema.safeParse(use.input);
  if (!parsed.success) {
    return {
      type: "tool_result",
      tool_use_id: use.id,
      content: `invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      is_error: true,
    };
  }

  if (isReadonlyTool(tool)) {
    try {
      const result = await tool.execute(parsed.data);
      toolCalls.push({ name: tool.name, readonly: true });
      return { type: "tool_result", tool_use_id: use.id, content: JSON.stringify(result) };
    } catch (err) {
      return {
        type: "tool_result",
        tool_use_id: use.id,
        content: `tool failed: ${err instanceof Error ? err.message : String(err)}`,
        is_error: true,
      };
    }
  }

  if (isApprovalTool(tool)) {
    // NEVER execute — render the card and tell the model it is pending.
    try {
      const preview = await tool.preview(parsed.data);
      pendingActions.push({
        id: randomUUID(),
        toolName: tool.name,
        input: parsed.data,
        signature: signPendingAction(tool.name, parsed.data),
        title: preview.title,
        details: preview.details,
      });
      toolCalls.push({ name: tool.name, readonly: false });
      return {
        type: "tool_result",
        tool_use_id: use.id,
        content:
          "PENDING_APPROVAL: the action was NOT performed. It is now shown to Noam as a preview card and will run only if she approves. Do not claim it happened.",
      };
    } catch (err) {
      return {
        type: "tool_result",
        tool_use_id: use.id,
        content: `preview failed: ${err instanceof Error ? err.message : String(err)}`,
        is_error: true,
      };
    }
  }

  return { type: "tool_result", tool_use_id: use.id, content: "tool has no execution mode", is_error: true };
}
