import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { switchUserAction } from "@/app/actions";
import { appName, console_, suppliersT } from "@/lib/i18n/he";
import type { SessionUser } from "@/lib/auth";

function todayIn(tz: string): string {
  return new Intl.DateTimeFormat("he-IL", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: tz,
  }).format(new Date());
}

export function ConsoleHeader({ user, users, tz }: { user: SessionUser; users: SessionUser[]; tz: string }) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-3 pb-6">
      <div>
        <div className="text-xs font-medium tracking-wide text-muted-foreground">{appName}</div>
        <h1 className="text-2xl font-bold">
          {greeting(tz)}, {user.name.split(" ")[0]}
        </h1>
        <div className="text-sm text-muted-foreground">{todayIn(tz)}</div>
      </div>
      <div className="flex items-center gap-3">
        <form action={switchUserAction} className="flex items-center gap-1.5">
          <label htmlFor="uid" className="text-xs text-muted-foreground">
            {console_.actAs}
          </label>
          <select
            id="uid"
            name="uid"
            defaultValue={user.id}
            className="h-8 rounded-md border bg-card px-2 text-xs"
          >
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
          <button type="submit" className="h-8 rounded-md border bg-card px-2 text-xs hover:bg-accent">
            ✓
          </button>
        </form>
        <Link href="/suppliers" className={buttonVariants({ variant: "outline", size: "default" })}>
          {suppliersT.title}
        </Link>
        <Link href="/requests/new" className={buttonVariants({ size: "default" })}>
          {console_.newRequest}
        </Link>
      </div>
    </header>
  );
}

function greeting(tz: string): string {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: tz }).format(
      new Date(),
    ),
  );
  if (hour < 12) return console_.greetingMorning;
  if (hour < 18) return console_.greetingNoon;
  return console_.greetingEvening;
}
