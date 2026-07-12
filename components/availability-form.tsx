"use client";

import { useActionState, useState } from "react";
import { submitAvailabilityAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { DayWindows } from "@/lib/services/availability";
import { availabilityT } from "@/lib/i18n/he";

const dayFmt = new Intl.DateTimeFormat("he-IL", { weekday: "short", day: "numeric", month: "numeric" });

function keyOf(date: string, start: string): string {
  return `${date}|${start}`;
}

export function AvailabilityForm({
  token,
  days,
  note,
}: {
  token: string;
  days: DayWindows[];
  note: string | null;
}) {
  const [state, formAction, pending] = useActionState(submitAvailabilityAction, {});
  const [marked, setMarked] = useState<Set<string>>(
    () =>
      new Set(
        days.flatMap((d) =>
          d.windows.filter((w) => w.status === "AVAILABLE").map((w) => keyOf(d.date, w.start)),
        ),
      ),
  );

  if (state.savedCount !== undefined) {
    return (
      <div className="rounded-xl border bg-card p-6 text-center shadow-sm">
        <div className="text-3xl">✅</div>
        <h2 className="mt-2 text-lg font-bold">{availabilityT.savedTitle}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {availabilityT.savedCount(state.savedCount)} · {availabilityT.savedBody}
        </p>
      </div>
    );
  }

  function toggle(k: string) {
    setMarked((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  // Group by calendar week (Sunday-first, matching the Israeli week).
  const weeks: DayWindows[][] = [];
  for (const day of days) {
    const dow = new Date(`${day.date}T00:00:00`).getDay();
    if (weeks.length === 0 || dow === 0) weeks.push([]);
    weeks[weeks.length - 1].push(day);
  }

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <input type="hidden" name="token" value={token} />
      {[...marked].map((k) => (
        <input key={k} type="hidden" name="marked" value={k} />
      ))}

      {weeks.map((week) => (
        <section key={week[0].date} className="rounded-xl border bg-card p-3 shadow-sm">
          <h2 className="mb-2 text-sm font-semibold text-muted-foreground">
            {availabilityT.weekOf(dayFmt.format(new Date(`${week[0].date}T00:00:00`)))}
          </h2>
          <ul className="flex flex-col gap-1.5">
            {week.map((day) => (
              <li key={day.date} className="flex items-center gap-2">
                <span className="w-20 shrink-0 whitespace-nowrap text-sm tabular-nums">
                  {dayFmt.format(new Date(`${day.date}T00:00:00`))}
                </span>
                <div className="flex flex-1 gap-1.5">
                  {day.windows.map((w, i) => {
                    const k = keyOf(day.date, w.start);
                    const label = i === 0 ? availabilityT.morning : i === 1 ? availabilityT.afternoon : "";
                    if (!w.editable) {
                      return (
                        <span
                          key={w.start}
                          className="flex-1 rounded-lg bg-muted px-2 py-1.5 text-center text-xs text-muted-foreground"
                        >
                          {w.status === "CONFIRMED" ? availabilityT.booked : availabilityT.held}
                        </span>
                      );
                    }
                    const on = marked.has(k);
                    return (
                      <button
                        key={w.start}
                        type="button"
                        aria-pressed={on}
                        onClick={() => toggle(k)}
                        className={`flex-1 rounded-lg border px-2 py-1.5 text-center text-xs font-medium transition-colors ${
                          on
                            ? "border-transparent bg-primary text-primary-foreground"
                            : "bg-background text-muted-foreground hover:bg-accent"
                        }`}
                      >
                        {label} {w.start}–{w.end}
                      </button>
                    );
                  })}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}

      <div className="grid gap-1.5">
        <label htmlFor="note" className="text-sm font-medium">
          {availabilityT.notes}
        </label>
        <Textarea id="note" name="note" defaultValue={note ?? ""} placeholder={availabilityT.notesPlaceholder} />
      </div>

      {state.error ? <p className="text-sm font-medium text-destructive">{state.error}</p> : null}
      <Button type="submit" size="lg" disabled={pending} className="sticky bottom-4 shadow-lg">
        {availabilityT.save}
      </Button>
    </form>
  );
}
