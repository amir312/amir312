import { ConsoleHeader } from "@/components/console/header";
import { ExceptionCard } from "@/components/console/exception-card";
import { UpcomingShoots } from "@/components/console/upcoming";
import { currentUser, listActiveUsers } from "@/lib/auth";
import { console_ } from "@/lib/i18n/he";
import { getExceptions, getTimezone, getUpcoming } from "@/lib/services/console";

export const dynamic = "force-dynamic";

export default async function ConsolePage() {
  const [user, users, exceptions, upcoming, tz] = await Promise.all([
    currentUser(),
    listActiveUsers(),
    getExceptions(),
    getUpcoming(),
    getTimezone(),
  ]);

  return (
    <main className="mx-auto max-w-4xl px-4 py-6">
      <ConsoleHeader user={user} users={users} tz={tz} />

      <section aria-label={console_.title}>
        <div className="mb-3 flex items-baseline gap-2">
          <h2 className="text-lg font-bold">{console_.title}</h2>
          {exceptions.length > 0 ? (
            <span className="rounded-full bg-sev-escalated px-2 py-0.5 text-xs font-bold text-white">
              {exceptions.length}
            </span>
          ) : null}
        </div>
        {exceptions.length === 0 ? (
          <div className="rounded-xl border border-dashed bg-sev-ok-bg p-8 text-center text-sm font-medium text-sev-ok">
            {console_.empty}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {exceptions.map((item) => (
              <ExceptionCard key={item.incidentId ?? `${item.shootRequestId}:${item.action}`} item={item} />
            ))}
          </div>
        )}
      </section>

      <section aria-label={console_.upcomingTitle} className="mt-10">
        <h2 className="mb-3 text-lg font-bold">{console_.upcomingTitle}</h2>
        <UpcomingShoots slots={upcoming} />
      </section>
    </main>
  );
}
