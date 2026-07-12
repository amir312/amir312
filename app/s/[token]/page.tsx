import { AvailabilityForm } from "@/components/availability-form";
import { availabilityT } from "@/lib/i18n/he";
import { getAvailabilityPage, verifyAvailabilityToken } from "@/lib/services/availability";

export const dynamic = "force-dynamic";

// Mobile-first, no account: the photographer opens the weekly link and marks
// free 4-hour windows. Everything supplier-scoped runs under the RLS role.
export default async function SupplierAvailabilityPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const verified = await verifyAvailabilityToken(token);

  if (!verified.ok || !verified.token.supplierId) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-2 px-6 text-center">
        <h1 className="text-xl font-bold">{availabilityT.invalidTitle}</h1>
        <p className="text-sm text-muted-foreground">{availabilityT.invalidBody}</p>
      </main>
    );
  }

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
