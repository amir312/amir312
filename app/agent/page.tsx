import Link from "next/link";
import { AgentChat } from "@/components/agent-chat";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { hasAgentApiKey } from "@/lib/agent/run";
import { agentT, detail } from "@/lib/i18n/he";

export const dynamic = "force-dynamic";

// Noam's operational assistant: reads everything, performs nothing without
// an explicit approval click (CLAUDE.md invariant 1).
export default function AgentPage() {
  const connected = hasAgentApiKey();

  return (
    <main className="mx-auto max-w-2xl px-4 py-6">
      <Link href="/" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
        ← {detail.backToConsole}
      </Link>
      <h1 className="mt-3 text-2xl font-bold">{agentT.title}</h1>
      <p className="mb-6 mt-1 text-sm text-muted-foreground">{agentT.subtitle}</p>

      {connected ? (
        <AgentChat />
      ) : (
        <Alert variant="warning">
          <AlertTitle>{agentT.noKeyTitle}</AlertTitle>
          <AlertDescription>{agentT.noKeyBody}</AlertDescription>
        </Alert>
      )}
    </main>
  );
}
