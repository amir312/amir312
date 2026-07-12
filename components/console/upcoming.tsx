import { Badge } from "@/components/ui/badge";
import { console_, shortDate } from "@/lib/i18n/he";
import { bizDate, type UpcomingSlot } from "@/lib/services/console";

function bucketOf(date: string, tz: string): string {
  if (date === bizDate(tz, 0)) return console_.today;
  if (date === bizDate(tz, 1)) return console_.tomorrow;
  return console_.thisWeek;
}

export function UpcomingShoots({ slots }: { slots: UpcomingSlot[] }) {
  if (slots.length === 0) {
    return <p className="text-sm text-muted-foreground">{console_.emptyUpcoming}</p>;
  }

  const buckets = new Map<string, UpcomingSlot[]>();
  for (const slot of slots) {
    const bucket = bucketOf(slot.date, slot.tz);
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket)!.push(slot);
  }

  return (
    <div className="flex flex-col gap-4">
      {[...buckets.entries()].map(([bucket, items]) => (
        <div key={bucket}>
          <h3 className="mb-2 text-sm font-semibold text-muted-foreground">{bucket}</h3>
          <div className="flex flex-col gap-1.5">
            {items.map((slot) => (
              <div
                key={`${slot.dayId}:${slot.requestId}`}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border bg-card px-4 py-2.5 text-sm"
              >
                <span className="font-medium tabular-nums">{shortDate(slot.date)}</span>
                <span className="tabular-nums text-muted-foreground" dir="ltr">
                  {slot.startTime.slice(0, 5)}–{slot.endTime.slice(0, 5)}
                </span>
                <span className="font-medium">{slot.clientName}</span>
                <span className="text-muted-foreground">📷 {slot.supplierName}</span>
                {slot.paired ? <Badge variant="secondary">{console_.paired}</Badge> : null}
                {slot.halfFree ? <Badge variant="overdue">{console_.halfDayFree}</Badge> : null}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
