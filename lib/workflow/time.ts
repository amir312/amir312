/**
 * Deterministic time math for deadline computation.
 * Pure functions only — no Date.now(), the event supplies the clock.
 *
 * Hour-of-day rules (e.g. t_minus_1_deadline_hour) are interpreted in the
 * business timezone from rules.timezone. Precision note: on a DST-switch day
 * the single-pass offset lookup can be off by one hour; deadlines here are
 * hour-grained business deadlines, so this is acceptable and documented.
 */

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

export function addHours(from: Date, hours: number): Date {
  return new Date(from.getTime() + hours * MS_PER_HOUR);
}

export function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * MS_PER_DAY);
}

/** Offset (minutes to ADD to UTC to get wall time) of `tz` at `date`. */
function tzOffsetMinutes(date: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour === "24" ? "0" : parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return (asUtc - date.getTime()) / 60_000;
}

/** The instant of `isoDate` (YYYY-MM-DD) at `hour` o'clock wall time in `tz`. */
export function dateAtHourInTz(isoDate: string, hour: number, tz: string): Date {
  const guess = new Date(`${isoDate}T${String(hour).padStart(2, "0")}:00:00Z`);
  const offset = tzOffsetMinutes(guess, tz);
  return new Date(guess.getTime() - offset * 60_000);
}

/** JS getDay() (0=Sunday … 6=Saturday) of `date` as seen in `tz`. */
export function dayOfWeekInTz(date: Date, tz: string): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(date);
  const idx = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name);
  return idx;
}

/**
 * `from` plus `n` business days, skipping the weekend days (JS getDay numbers)
 * as observed in `tz`. Keeps the time-of-day of `from`.
 */
export function addBusinessDays(from: Date, n: number, weekendDays: number[], tz: string): Date {
  if (new Set(weekendDays).size >= 7) {
    throw new Error("weekend_days covers the whole week — no business day can ever be reached");
  }
  let d = from;
  let added = 0;
  while (added < n) {
    d = addDays(d, 1);
    if (!weekendDays.includes(dayOfWeekInTz(d, tz))) added++;
  }
  return d;
}

/** ISO date (YYYY-MM-DD) shifted by n days. */
export function shiftIsoDate(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  const shifted = addDays(d, days);
  return shifted.toISOString().slice(0, 10);
}
