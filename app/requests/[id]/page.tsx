import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { db } from "@/db/client";
import { clients, events, shootRequests } from "@/db/schema";
import {
  actionLabels,
  detail,
  form as formT,
  ownerLabels,
  shootTypeLabels,
  statusLabels,
} from "@/lib/i18n/he";

export const dynamic = "force-dynamic";

const fmtDateTime = (d: Date) =>
  new Intl.DateTimeFormat("he-IL", {
    day: "numeric",
    month: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Jerusalem",
  }).format(d);

export default async function RequestDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ intake?: string }>;
}) {
  const { id } = await params;
  const { intake } = await searchParams;

  const [row] = await db()
    .select({ request: shootRequests, clientName: clients.name })
    .from(shootRequests)
    .innerJoin(clients, eq(clients.id, shootRequests.clientId))
    .where(eq(shootRequests.id, id));
  if (!row) notFound();
  const r = row.request;

  const timeline = await db()
    .select()
    .from(events)
    .where(and(eq(events.entityType, "shoot_request"), eq(events.entityId, id)))
    .orderBy(desc(events.createdAt), desc(events.id));

  return (
    <main className="mx-auto max-w-2xl px-4 py-6">
      <Link href="/" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
        ← {detail.backToConsole}
      </Link>

      {intake === "PENDING_MATCH" ? (
        <Alert variant="success" className="mt-4">
          <AlertTitle>{formT.submittedTitle}</AlertTitle>
        </Alert>
      ) : null}
      {intake === "ELIGIBILITY_HOLD" ? (
        <Alert variant="warning" className="mt-4">
          <AlertTitle>{formT.flaggedTitle}</AlertTitle>
          <AlertDescription>{formT.flaggedBody}</AlertDescription>
        </Alert>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">{row.clientName}</h1>
        <Badge variant="secondary">{shootTypeLabels[r.shootType]}</Badge>
        <Badge>{statusLabels[r.status]}</Badge>
      </div>
      {r.purpose ? <p className="mt-1 text-sm text-muted-foreground">{r.purpose}</p> : null}

      {r.currentOwnerType ? (
        <Card className="mt-5">
          <CardContent className="grid gap-3 p-5 sm:grid-cols-3">
            <div>
              <div className="text-xs text-muted-foreground">{detail.owner}</div>
              <div className="font-medium">{ownerLabels[r.currentOwnerType]}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">{detail.action}</div>
              <div className="font-medium">{r.currentAction ? actionLabels[r.currentAction] : "—"}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">{detail.due}</div>
              <div className="font-medium tabular-nums">
                {r.actionDueAt ? fmtDateTime(r.actionDueAt) : "—"}
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {r.status === "MISSING_INFO" ? (
        <div className="mt-4">
          <Link href={`/requests/${id}/edit`} className={buttonVariants({})}>
            {formT.editTitle}
          </Link>
        </div>
      ) : null}

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>{detail.timeline}</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="relative flex flex-col gap-4 border-s ps-4">
            {timeline.map((ev) => (
              <li key={ev.id} className="relative">
                <span className="absolute -start-[21px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-card bg-muted-foreground" />
                <div className="text-xs tabular-nums text-muted-foreground">
                  {fmtDateTime(ev.createdAt)} · {ownerLabels[ev.actorType]}
                </div>
                <div className="text-sm">{ev.summary}</div>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </main>
  );
}
