"use client";

import { useActionState } from "react";
import { briefChoiceAction, type BriefChoiceState } from "@/app/actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { briefT } from "@/lib/i18n/he";

export function BriefApprovalForm({ token }: { token: string }) {
  const [state, formAction, pending] = useActionState<BriefChoiceState, FormData>(
    briefChoiceAction,
    {},
  );

  if (state.outcome === "APPROVED") {
    return (
      <Alert variant="success">
        <AlertTitle>{briefT.approvedTitle}</AlertTitle>
        <AlertDescription>{briefT.approvedBody}</AlertDescription>
      </Alert>
    );
  }
  if (state.outcome === "CHANGES") {
    return (
      <Alert variant="success">
        <AlertTitle>{briefT.changesTitle}</AlertTitle>
        <AlertDescription>{briefT.changesBody}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {state.error ? (
        <Alert variant="warning">
          <AlertTitle>{state.error}</AlertTitle>
        </Alert>
      ) : null}
      <form action={formAction}>
        <input type="hidden" name="token" value={token} />
        <input type="hidden" name="decision" value="approve" />
        <Button type="submit" size="lg" className="w-full" disabled={pending}>
          {briefT.approve}
        </Button>
      </form>
      {/* Always rendered (native <details>) — requesting changes must work without JS too. */}
      <details className="rounded-lg border">
        <summary className="cursor-pointer p-3 text-sm font-medium">
          {briefT.requestChanges}
        </summary>
        <form action={formAction} className="flex flex-col gap-2 border-t p-3">
          <input type="hidden" name="token" value={token} />
          <input type="hidden" name="decision" value="changes" />
          <label className="text-sm font-medium" htmlFor="brief-feedback">
            {briefT.feedbackLabel}
          </label>
          <textarea
            id="brief-feedback"
            name="feedback"
            rows={4}
            required
            className="w-full rounded-md border bg-transparent p-2 text-sm"
            placeholder={briefT.feedbackPlaceholder}
          />
          <Button type="submit" variant="outline" disabled={pending}>
            {briefT.requestChanges}
          </Button>
        </form>
      </details>
    </div>
  );
}
