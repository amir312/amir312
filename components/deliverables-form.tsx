"use client";

import { useActionState } from "react";
import {
  deliverablesMarkDoneAction,
  deliverablesSubmitAction,
  type DeliverablesActionState,
} from "@/app/actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { deliverablesT } from "@/lib/i18n/he";

/**
 * The photographer's two-step page: "the shoot happened" → the upload form.
 * `stage` comes from the server; a successful action advances it locally.
 */
export function DeliverablesForm({
  token,
  stage,
  uploadExplain,
}: {
  token: string;
  stage: "MARK_DONE" | "UPLOAD" | "DONE";
  uploadExplain: string;
}) {
  const [doneState, markDoneAction, markPending] = useActionState<DeliverablesActionState, FormData>(
    deliverablesMarkDoneAction,
    {},
  );
  const [submitState, submitAction, submitPending] = useActionState<
    DeliverablesActionState,
    FormData
  >(deliverablesSubmitAction, {});

  const effectiveStage = submitState.stage ?? doneState.stage ?? stage;
  const error = submitState.error ?? doneState.error;

  if (effectiveStage === "DONE") {
    return (
      <Alert variant="success">
        <AlertTitle>{deliverablesT.submittedTitle}</AlertTitle>
        <AlertDescription>{deliverablesT.submittedBody}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <Alert variant="warning">
          <AlertTitle>{error}</AlertTitle>
        </Alert>
      ) : null}

      {effectiveStage === "MARK_DONE" ? (
        <form action={markDoneAction} className="flex flex-col gap-2">
          <input type="hidden" name="token" value={token} />
          <p className="text-sm font-medium">{deliverablesT.shootDone}</p>
          <Button type="submit" size="lg" disabled={markPending}>
            {deliverablesT.markDone}
          </Button>
        </form>
      ) : (
        <form action={submitAction} className="flex flex-col gap-3">
          <input type="hidden" name="token" value={token} />
          {doneState.stage === "UPLOAD" ? (
            <Alert variant="success">
              <AlertTitle>{deliverablesT.markedDone}</AlertTitle>
            </Alert>
          ) : null}
          <p className="text-sm text-muted-foreground">{uploadExplain}</p>
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium" htmlFor="drive-url">
              {deliverablesT.driveUrlLabel}
            </label>
            <input
              id="drive-url"
              name="driveUrl"
              type="url"
              required
              dir="ltr"
              placeholder={deliverablesT.driveUrlPlaceholder}
              className="w-full rounded-md border bg-transparent p-2 text-sm"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium" htmlFor="raw-url">
              {deliverablesT.rawUrlLabel}
            </label>
            <input
              id="raw-url"
              name="rawUrl"
              type="url"
              dir="ltr"
              placeholder={deliverablesT.driveUrlPlaceholder}
              className="w-full rounded-md border bg-transparent p-2 text-sm"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium" htmlFor="supplier-note">
              {deliverablesT.noteLabel}
            </label>
            <textarea
              id="supplier-note"
              name="note"
              rows={3}
              placeholder={deliverablesT.notePlaceholder}
              className="w-full rounded-md border bg-transparent p-2 text-sm"
            />
          </div>
          <Button type="submit" size="lg" disabled={submitPending}>
            {deliverablesT.submit}
          </Button>
        </form>
      )}
    </div>
  );
}
