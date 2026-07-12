"use client";

import { useActionState, useRef } from "react";
import { addNoteAction, type NoteActionState } from "@/app/actions";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { noteT } from "@/lib/i18n/he";

/** Noam's "context that arrived by phone" box — writes a MANUAL_NOTE event. */
export function NoteForm({ requestId }: { requestId: string }) {
  const [state, formAction, pending] = useActionState<NoteActionState, FormData>(
    async (prev, fd) => {
      const result = await addNoteAction(requestId, prev, fd);
      if (!result.error) formRef.current?.reset();
      return result;
    },
    {},
  );
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <form ref={formRef} action={formAction} className="flex flex-col gap-2">
      {state.error ? (
        <Alert variant="warning">
          <AlertTitle>{state.error}</AlertTitle>
        </Alert>
      ) : null}
      {state.message ? (
        <Alert variant="success">
          <AlertTitle>{state.message}</AlertTitle>
        </Alert>
      ) : null}
      <textarea
        name="note"
        rows={2}
        required
        placeholder={noteT.placeholder}
        className="w-full rounded-md border bg-transparent p-2 text-sm"
      />
      <div>
        <Button type="submit" variant="outline" size="sm" disabled={pending}>
          {noteT.add}
        </Button>
      </div>
    </form>
  );
}
