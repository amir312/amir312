import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { BriefContentView } from "@/components/brief-content";
import { BriefEditor } from "@/components/brief-editor";
import { NoteForm } from "@/components/note-form";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { db } from "@/db/client";
import {
  clients,
  deliverables,
  events,
  shootRequests,
  shootSlots,
  slotProposals,
  supplierDays,
  suppliers,
} from "@/db/schema";
import { templateFor, type BriefContent } from "@/lib/brief/templates";
import {
  actionLabels,
  briefT,
  deliverablesT,
  detail,
  form as formT,
  noteT,
  ownerLabels,
  proposalsT,
  shootTypeLabels,
  shortDate,
  statusLabels,
} from "@/lib/i18n/he";
import { getBrief } from "@/lib/services/briefs";

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

  const [timeline, proposals, brief, slot, deliverable] = await Promise.all([
    db()
      .select()
      .from(events)
      .where(and(eq(events.entityType, "shoot_request"), eq(events.entityId, id)))
      .orderBy(desc(events.createdAt), desc(events.id)),
    db()
      .select()
      .from(slotProposals)
      .where(eq(slotProposals.shootRequestId, id))
      .orderBy(desc(slotProposals.createdAt)),
    getBrief(id),
    r.slotId
      ? db()
          .select({
            shootDate: supplierDays.date,
            startTime: shootSlots.startTime,
            endTime: shootSlots.endTime,
            supplierName: suppliers.name,
            contactedAt: shootSlots.supplierContactedClientAt,
          })
          .from(shootSlots)
          .innerJoin(supplierDays, eq(supplierDays.id, shootSlots.supplierDayId))
          .innerJoin(suppliers, eq(suppliers.id, supplierDays.supplierId))
          .where(eq(shootSlots.id, r.slotId))
          .then((rows) => rows[0] ?? null)
      : Promise.resolve(null),
    db()
      .select()
      .from(deliverables)
      .where(eq(deliverables.shootRequestId, id))
      .then((rows) => rows[0] ?? null),
  ]);

  const briefEditable =
    r.needsBrief &&
    (r.status === "CONFIRMED" || r.status === "BRIEF_PENDING") &&
    brief.brief?.status !== "APPROVED" &&
    brief.brief?.status !== "SENT_TO_SUPPLIER" &&
    brief.brief?.status !== "CLIENT_REVIEW";

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
      {slot ? (
        <p className="mt-1 text-sm font-medium">
          📅 {shortDate(slot.shootDate)} · {slot.startTime.slice(0, 5)}–{slot.endTime.slice(0, 5)} ·{" "}
          {slot.supplierName}
        </p>
      ) : null}

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

      {r.needsBrief && (brief.brief || briefEditable) ? (
        <Card className="mt-6">
          <CardHeader>
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle>{briefT.cardTitle}</CardTitle>
              {brief.brief ? (
                <Badge variant="secondary">{briefT.statusLabels[brief.brief.status]}</Badge>
              ) : null}
              {brief.brief?.dueAt ? (
                <span className="text-xs text-muted-foreground">
                  {briefT.dueBy}: {fmtDateTime(brief.brief.dueAt)}
                </span>
              ) : null}
            </div>
          </CardHeader>
          <CardContent>
            {brief.latest?.clientFeedback ? (
              <Alert variant="warning" className="mb-3">
                <AlertTitle>{briefT.clientFeedback}</AlertTitle>
                <AlertDescription>{brief.latest.clientFeedback}</AlertDescription>
              </Alert>
            ) : null}
            {brief.approved ? (
              <>
                <p className="mb-3 text-xs text-muted-foreground">
                  {briefT.approvedLocked} · {briefT.version(brief.approved.version)}
                </p>
                <BriefContentView content={brief.approved.content as BriefContent} />
              </>
            ) : briefEditable ? (
              <BriefEditor
                requestId={id}
                fields={templateFor(r.shootType, r.needsScript)}
                content={(brief.latest?.content as BriefContent | undefined) ?? {}}
                canSend={Boolean(brief.latest)}
              />
            ) : brief.latest ? (
              <>
                <p className="mb-3 text-xs text-muted-foreground">
                  {briefT.version(brief.latest.version)}
                </p>
                <BriefContentView content={brief.latest.content as BriefContent} />
              </>
            ) : (
              <p className="text-sm text-muted-foreground">{briefT.notStartedYet}</p>
            )}
          </CardContent>
        </Card>
      ) : null}

      {deliverable ? (
        <Card className="mt-6">
          <CardHeader>
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle>{deliverablesT.cardTitle}</CardTitle>
              <Badge variant="secondary">{deliverablesT.statusLabels[deliverable.status]}</Badge>
              {deliverable.dueAt ? (
                <span className="text-xs text-muted-foreground">
                  {deliverablesT.dueBy}: {fmtDateTime(deliverable.dueAt)}
                </span>
              ) : null}
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            {deliverable.driveUrl ? (
              <a
                href={deliverable.driveUrl}
                target="_blank"
                rel="noreferrer"
                className="text-primary underline underline-offset-4"
                dir="ltr"
              >
                {deliverable.driveUrl}
              </a>
            ) : null}
            {deliverable.rawUrl ? (
              <a
                href={deliverable.rawUrl}
                target="_blank"
                rel="noreferrer"
                className="text-muted-foreground underline underline-offset-4"
                dir="ltr"
              >
                {deliverable.rawUrl}
              </a>
            ) : null}
            {deliverable.supplierNote ? (
              <p className="text-muted-foreground">
                {deliverablesT.supplierNote}: {deliverable.supplierNote}
              </p>
            ) : null}
            {deliverable.forwardedTo ? (
              <p className="text-xs text-muted-foreground">
                {deliverablesT.forwardedTo(
                  deliverable.forwardedTo === "SOCIAL_MANAGER"
                    ? ownerLabels.SOCIAL_MANAGER
                    : ownerLabels.CLIENT,
                )}
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {proposals.length > 0 ? (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>{proposalsT.title}</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-3">
              {proposals.map((p) => (
                <li key={p.id} className="rounded-lg border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold">
                      {shortDate(p.date)} · {p.startTime.slice(0, 5)}–{p.endTime.slice(0, 5)}
                    </span>
                    <Badge variant={p.pairedDayId ? "secondary" : "outline"}>
                      {p.pairedDayId ? proposalsT.paired : proposalsT.solo}
                    </Badge>
                    <Badge variant="outline">
                      {proposalsT.statusLabels[p.status] ?? p.status}
                    </Badge>
                    {p.score ? (
                      <span className="text-xs text-muted-foreground">
                        {proposalsT.score}: {Number(p.score).toFixed(0)}
                      </span>
                    ) : null}
                  </div>
                  {p.reason ? (
                    <p className="mt-1 text-sm text-muted-foreground">{p.reason}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>{detail.timeline}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="mb-4 border-b pb-4">
            <div className="mb-2 text-xs font-medium text-muted-foreground">{noteT.title}</div>
            <NoteForm requestId={id} />
          </div>
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
