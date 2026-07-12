"use client";

import { useActionState } from "react";
import { t1ConfirmAction, type T1ActionState } from "@/app/actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { t1T } from "@/lib/i18n/he";

export function T1ConfirmForm({ token }: { token: string }) {
  const [state, formAction, pending] = useActionState<T1ActionState, FormData>(
    t1ConfirmAction,
    {},
  );

  if (state.confirmed) {
    return (
      <Alert variant="success">
        <AlertTitle>{state.already ? t1T.alreadyConfirmed : t1T.confirmedTitle}</AlertTitle>
        {!state.already ? <AlertDescription>{t1T.confirmedBody}</AlertDescription> : null}
      </Alert>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="token" value={token} />
      {state.error ? (
        <Alert variant="warning">
          <AlertTitle>{state.error}</AlertTitle>
        </Alert>
      ) : null}
      <Button type="submit" size="lg" className="w-full text-lg" disabled={pending}>
        {t1T.confirm}
      </Button>
    </form>
  );
}
