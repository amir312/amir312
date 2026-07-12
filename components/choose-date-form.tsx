"use client";

import { useActionState } from "react";
import { chooseDateAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { chooseT, shortDate } from "@/lib/i18n/he";

const weekdayFmt = new Intl.DateTimeFormat("he-IL", { weekday: "long" });

export function ChooseDateForm({
  token,
  options,
}: {
  token: string;
  options: Array<{ proposalId: string; date: string; start: string; end: string }>;
}) {
  const [state, formAction, pending] = useActionState(chooseDateAction, {});

  if (state.outcome === "CONFIRMED") {
    return (
      <div className="rounded-xl border bg-card p-6 text-center shadow-sm">
        <div className="text-3xl">📸</div>
        <h2 className="mt-2 text-lg font-bold">{chooseT.confirmedTitle}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {chooseT.confirmedBody(state.date ?? "")}
        </p>
      </div>
    );
  }
  if (state.outcome === "DECLINED") {
    return (
      <div className="rounded-xl border bg-card p-6 text-center shadow-sm">
        <h2 className="text-lg font-bold">{chooseT.declinedTitle}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{chooseT.declinedBody}</p>
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="token" value={token} />
      {options.map((o) => (
        <div key={o.proposalId} className="rounded-xl border bg-card p-4 shadow-sm">
          <div className="text-base font-semibold">
            {weekdayFmt.format(new Date(`${o.date}T00:00:00`))}, {shortDate(o.date)}
          </div>
          <div className="mt-0.5 text-sm text-muted-foreground" dir="ltr">
            {o.start}–{o.end}
          </div>
          <Button
            type="submit"
            name="proposalId"
            value={o.proposalId}
            disabled={pending}
            className="mt-3 w-full"
            size="lg"
          >
            {chooseT.choose}
          </Button>
        </div>
      ))}

      {state.error ? <p className="text-sm font-medium text-destructive">{state.error}</p> : null}

      <Button
        type="submit"
        name="decline"
        value="1"
        variant="outline"
        disabled={pending}
        className="mt-2"
      >
        {chooseT.noneFits}
      </Button>
    </form>
  );
}
