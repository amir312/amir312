import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { updateRequestAction, type IntakeFormState } from "@/app/actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { RequestForm } from "@/components/request-form";
import { db } from "@/db/client";
import { clients, shootRequests } from "@/db/schema";
import { detail, fieldLabels, form as t } from "@/lib/i18n/he";
import { validateRequestFields } from "@/lib/validation/request";

export const dynamic = "force-dynamic";

export default async function EditRequestPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ created?: string }>;
}) {
  const { id } = await params;
  const { created } = await searchParams;

  const [request] = await db().select().from(shootRequests).where(eq(shootRequests.id, id));
  if (!request) notFound();
  if (request.status !== "MISSING_INFO" && request.status !== "DRAFT") {
    redirect(`/requests/${id}`);
  }

  const clientRows = await db()
    .select({ id: clients.id, name: clients.name })
    .from(clients)
    .where(eq(clients.status, "ACTIVE"))
    .orderBy(asc(clients.name));

  const { missingFields } = validateRequestFields({
    address: request.address ?? undefined,
    regionCode: request.regionCode ?? undefined,
    onsiteContactName: request.onsiteContactName ?? undefined,
    onsiteContactPhone: request.onsiteContactPhone ?? undefined,
    purpose: request.purpose ?? undefined,
    clientWindows: request.clientWindows ?? [],
    needsBrief: request.needsBrief,
    needsScript: request.needsScript,
    targetDate: request.targetDate,
    flexibility: request.flexibility,
    specialRequirements: request.specialRequirements,
    notes: request.notes,
  });

  const boundAction = updateRequestAction.bind(null, id) as (
    prev: IntakeFormState,
    fd: FormData,
  ) => Promise<IntakeFormState>;

  return (
    <main className="mx-auto max-w-2xl px-4 py-6">
      <Link href="/" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
        ← {detail.backToConsole}
      </Link>
      <h1 className="mt-2 text-2xl font-bold">{t.editTitle}</h1>
      {created && missingFields.length > 0 ? (
        <Alert variant="warning" className="mt-4">
          <AlertTitle>{t.missingTitle}</AlertTitle>
          <AlertDescription>
            {t.missingBody} {missingFields.map((f) => fieldLabels[f] ?? f).join(", ")}
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="mt-6">
        <RequestForm
          clients={clientRows}
          defaults={{
            clientId: request.clientId,
            shootType: request.shootType,
            address: request.address,
            regionCode: request.regionCode,
            onsiteContactName: request.onsiteContactName,
            onsiteContactPhone: request.onsiteContactPhone,
            purpose: request.purpose,
            clientWindows: (request.clientWindows as Array<{ from?: string; to?: string }>) ?? [],
            needsBrief: request.needsBrief,
            needsScript: request.needsScript,
            targetDate: request.targetDate,
            flexibility: request.flexibility,
            specialRequirements: request.specialRequirements,
            notes: request.notes,
          }}
          action={boundAction}
          submitLabel={t.resubmit}
          lockPrereqs
        />
      </div>
    </main>
  );
}
