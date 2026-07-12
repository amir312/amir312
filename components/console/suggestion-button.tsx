"use client";

import { useActionState } from "react";
import { executeSuggestionAction, type SuggestionActionState } from "@/app/actions";
import { Button } from "@/components/ui/button";

/**
 * The one-click recommended action. Executes the mapped operation through the
 * service layer and reports the outcome inline — no toast library, no modal.
 */
export function SuggestionButton({
  suggestionKey,
  label,
  requestId,
  incidentId,
  variant = "default",
}: {
  suggestionKey: string;
  label: string;
  requestId?: string | null;
  incidentId?: string | null;
  variant?: "default" | "outline";
}) {
  const [state, formAction, pending] = useActionState<SuggestionActionState, FormData>(
    executeSuggestionAction,
    {},
  );

  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="key" value={suggestionKey} />
      {requestId ? <input type="hidden" name="requestId" value={requestId} /> : null}
      {incidentId ? <input type="hidden" name="incidentId" value={incidentId} /> : null}
      <Button type="submit" variant={variant} size="sm" disabled={pending}>
        {pending ? "…" : label}
      </Button>
      {state.message ? <span className="text-xs text-sev-ok font-medium">{state.message}</span> : null}
      {state.error ? <span className="text-xs text-destructive">{state.error}</span> : null}
    </form>
  );
}
