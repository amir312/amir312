"use client";

import { useRef, useState, useTransition } from "react";
import {
  agentChatAction,
  approveAgentActionAction,
  type AgentChatState,
} from "@/app/actions";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { PendingAction } from "@/lib/agent/run";
import { agentT } from "@/lib/i18n/he";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  toolCalls?: Array<{ name: string; readonly: boolean }>;
  pendingActions?: PendingAction[];
}

/** One approval card: the preview Noam sees, with the button that makes it real. */
function ApprovalCard({ action }: { action: PendingAction }) {
  const [state, setState] = useState<"pending" | "working" | "done" | "denied" | "failed">(
    "pending",
  );
  const [message, setMessage] = useState<string>("");

  async function approve() {
    setState("working");
    const result = await approveAgentActionAction(action.toolName, action.input, action.signature);
    if (result.ok) {
      setState("done");
      setMessage(result.message ?? agentT.approvedToast);
    } else {
      setState("failed");
      setMessage(result.error ?? agentT.errorTurn);
    }
  }

  return (
    <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-950">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="overdue">{agentT.pendingTitle}</Badge>
        <span className="text-sm font-semibold">{action.title}</span>
      </div>
      <ul className="mt-2 flex flex-col gap-1">
        {action.details.map((d, i) => (
          <li key={i} className="whitespace-pre-wrap text-sm">
            {d}
          </li>
        ))}
      </ul>
      <div className="mt-3 flex items-center gap-2">
        {state === "pending" || state === "working" ? (
          <>
            <Button size="sm" onClick={approve} disabled={state === "working"}>
              {agentT.approve}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={state === "working"}
              onClick={() => {
                setState("denied");
                setMessage(agentT.denied);
              }}
            >
              {agentT.deny}
            </Button>
          </>
        ) : (
          <span
            className={`text-sm font-medium ${state === "failed" ? "text-red-600 dark:text-red-400" : ""}`}
          >
            {message}
          </span>
        )}
      </div>
    </div>
  );
}

export function AgentChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const bottomRef = useRef<HTMLDivElement>(null);

  function send() {
    const text = input.trim();
    if (!text || pending) return;
    setInput("");
    setError(null);
    const nextMessages: ChatMessage[] = [...messages, { role: "user", content: text }];
    setMessages(nextMessages);

    startTransition(async () => {
      const history = nextMessages.map((m) => ({ role: m.role, content: m.content }));
      const result: AgentChatState = await agentChatAction(history);
      if (result.error || !result.reply) {
        setError(result.error ?? agentT.errorTurn);
        return;
      }
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: result.reply!,
          toolCalls: result.toolCalls,
          pendingActions: result.pendingActions,
        },
      ]);
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        {messages.map((m, i) => (
          <div
            key={i}
            className={`rounded-xl border p-3 ${m.role === "user" ? "bg-accent/40" : "bg-card"}`}
          >
            <div className="mb-1 text-xs font-semibold text-muted-foreground">
              {m.role === "user" ? agentT.you : agentT.assistant}
              {m.toolCalls && m.toolCalls.length > 0 ? (
                <span className="ms-2 font-normal">
                  {agentT.usedTools} {m.toolCalls.map((t) => t.name).join(", ")}
                </span>
              ) : null}
            </div>
            <div className="whitespace-pre-wrap text-sm">{m.content}</div>
            {m.pendingActions?.map((a) => <ApprovalCard key={a.id} action={a} />)}
          </div>
        ))}
        {pending ? <div className="text-sm text-muted-foreground">{agentT.thinking}</div> : null}
        {error ? (
          <Alert variant="warning">
            <AlertTitle>{error}</AlertTitle>
          </Alert>
        ) : null}
        <div ref={bottomRef} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        className="flex gap-2"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={agentT.placeholder}
          className="w-full rounded-md border bg-transparent p-2 text-sm"
        />
        <Button type="submit" disabled={pending || input.trim() === ""}>
          {agentT.send}
        </Button>
        {messages.length > 0 ? (
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => {
              setMessages([]);
              setError(null);
            }}
          >
            {agentT.newChat}
          </Button>
        ) : null}
      </form>
    </div>
  );
}
