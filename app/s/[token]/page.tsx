import { AvailabilityForm } from "@/components/availability-form";
import { BriefContentView } from "@/components/brief-content";
import { DeliverablesForm } from "@/components/deliverables-form";
import { T1ConfirmForm } from "@/components/t1-confirm-form";
import { db } from "@/db/client";
import { availabilityT, briefT, deliverablesT, shortDate, t1T } from "@/lib/i18n/he";
import { getAvailabilityPage, verifyAvailabilityToken } from "@/lib/services/availability";
import { getSupplierBriefView } from "@/lib/services/briefs";
import { getTimezone } from "@/lib/services/console";
import { getDeliverablesPage } from "@/lib/services/deliverables";
import { getT1Page } from "@/lib/services/t1";
import { peekTokenPurpose } from "@/lib/tokens";

export const dynamic = "force-dynamic";

function InvalidLink() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-2 px-6 text-center">
      <h1 className="text-xl font-bold">{availabilityT.invalidTitle}</h1>
      <p className="text-sm text-muted-foreground">{availabilityT.invalidBody}</p>
    </main>
  );
}

// Mobile-first, no account. One supplier link route, purpose-dispatched:
// weekly availability, the T-1 one-button page, the deliverables page, or the
// read-only approved brief.
export default async function SupplierLinkPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const purpose = await peekTokenPurpose(db(), token);

  if (purpose === "CONFIRM_T1") return <T1Page token={token} />;
  if (purpose === "UPLOAD_DELIVERABLES") return <DeliverablesPage token={token} />;
  if (purpose === "VIEW_SHOOT") return <BriefViewPage token={token} />;
  return <AvailabilityPage token={token} />;
}

async function AvailabilityPage({ token }: { token: string }) {
  const verified = await verifyAvailabilityToken(token);
  if (!verified.ok || !verified.token.supplierId) return <InvalidLink />;

  const page = await getAvailabilityPage(verified.token.supplierId);
  return (
    <main className="mx-auto max-w-md px-4 py-6">
      <h1 className="text-xl font-bold">{availabilityT.hello(page.supplierName)}</h1>
      <p className="mb-5 mt-1 text-sm text-muted-foreground">
        {availabilityT.explain(page.weeksAhead)}
      </p>
      <AvailabilityForm token={token} days={page.days} note={page.note} />
    </main>
  );
}

async function T1Page({ token }: { token: string }) {
  const result = await getT1Page(token);
  if (!result.ok) return <InvalidLink />;
  const { page } = result;
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-8">
      <h1 className="text-xl font-bold">{t1T.hello(page.supplierName)}</h1>
      <p className="mt-2 text-sm">
        {t1T.explain(page.clientName, shortDate(page.shootDate), page.address)}
      </p>
      <p className="mb-5 mt-4 text-base font-medium">{t1T.question}</p>
      {page.alreadyConfirmed ? (
        <p className="rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-center text-sm font-medium text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100">
          {t1T.alreadyConfirmed}
        </p>
      ) : (
        <T1ConfirmForm token={token} />
      )}
    </main>
  );
}

async function DeliverablesPage({ token }: { token: string }) {
  const result = await getDeliverablesPage(token);
  if (!result.ok) return <InvalidLink />;
  const { page } = result;
  if (page.stage === "DONE") {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-2 px-6 text-center">
        <div className="text-3xl">🙌</div>
        <h1 className="text-xl font-bold">{deliverablesT.submittedTitle}</h1>
        <p className="text-sm text-muted-foreground">{deliverablesT.alreadySubmitted}</p>
      </main>
    );
  }
  const dueText = page.dueAt
    ? new Intl.DateTimeFormat("he-IL", {
        day: "numeric",
        month: "numeric",
        timeZone: await getTimezone(),
      }).format(page.dueAt)
    : shortDate(page.shootDate);
  return (
    <main className="mx-auto max-w-md px-4 py-8">
      <h1 className="text-xl font-bold">{deliverablesT.hello(page.supplierName)}</h1>
      <h2 className="mb-4 mt-1 text-sm text-muted-foreground">{deliverablesT.uploadTitle}</h2>
      <DeliverablesForm
        token={token}
        stage={page.stage}
        uploadExplain={deliverablesT.uploadExplain(page.clientName, dueText)}
      />
    </main>
  );
}

async function BriefViewPage({ token }: { token: string }) {
  const result = await getSupplierBriefView(token);
  if (!result.ok) return <InvalidLink />;
  const { view } = result;
  return (
    <main className="mx-auto max-w-md px-4 py-8">
      <h1 className="text-xl font-bold">{briefT.cardTitle} — {view.clientName}</h1>
      <p className="mb-4 mt-1 text-sm text-muted-foreground">
        {shortDate(view.shootDate)}
        {view.address ? ` · ${view.address}` : ""}
      </p>
      {view.content ? (
        <div className="rounded-lg border p-4">
          <BriefContentView content={view.content} />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{briefT.notStartedYet}</p>
      )}
    </main>
  );
}
