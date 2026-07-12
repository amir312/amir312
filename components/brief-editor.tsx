"use client";

import { useActionState } from "react";
import {
  saveBriefDraftAction,
  sendBriefToClientAction,
  type BriefEditState,
} from "@/app/actions";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { BriefContent, BriefFieldKey } from "@/lib/brief/templates";
import { briefFieldPlaceholders, briefFields, briefT } from "@/lib/i18n/he";

/**
 * The staff-side brief editor: the shoot-type template's fields, prefilled
 * from the latest draft. Saving stacks a new version; sending puts it in the
 * client's hands. Approved briefs never render this (read-only upstream).
 */
export function BriefEditor({
  requestId,
  fields,
  content,
  canSend,
}: {
  requestId: string;
  fields: BriefFieldKey[];
  content: BriefContent;
  canSend: boolean;
}) {
  const [saveState, saveAction, savePending] = useActionState<BriefEditState, FormData>(
    saveBriefDraftAction.bind(null, requestId),
    {},
  );
  const [sendState, sendAction, sendPending] = useActionState<BriefEditState, FormData>(
    sendBriefToClientAction.bind(null, requestId),
    {},
  );

  const notice = sendState.message ?? saveState.message;
  const error = sendState.error ?? saveState.error;

  return (
    <div className="flex flex-col gap-3">
      {notice ? (
        <Alert variant="success">
          <AlertTitle>{notice}</AlertTitle>
        </Alert>
      ) : null}
      {error ? (
        <Alert variant="warning">
          <AlertTitle>{error}</AlertTitle>
        </Alert>
      ) : null}
      <form action={saveAction} className="flex flex-col gap-3">
        {fields.map((key) => (
          <div key={key} className="flex flex-col gap-1">
            <label className="text-sm font-medium" htmlFor={`brief-${key}`}>
              {briefFields[key]}
            </label>
            <textarea
              id={`brief-${key}`}
              name={key}
              rows={key === "shotList" || key === "script" ? 4 : 2}
              defaultValue={content[key] ?? ""}
              placeholder={briefFieldPlaceholders[key]}
              className="w-full rounded-md border bg-transparent p-2 text-sm"
            />
          </div>
        ))}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="outline" disabled={savePending}>
            {briefT.saveDraft}
          </Button>
        </div>
      </form>
      {canSend ? (
        <form action={sendAction}>
          <Button type="submit" disabled={sendPending}>
            {briefT.sendToClient}
          </Button>
        </form>
      ) : null}
    </div>
  );
}
