import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { listSuppliers } from "@/lib/services/suppliers";
import { detail, regionLabels, shootTypeLabels, suppliersT } from "@/lib/i18n/he";

export const dynamic = "force-dynamic";

export default async function SuppliersPage() {
  const rows = await listSuppliers();

  return (
    <main className="mx-auto max-w-3xl px-4 py-6">
      <Link href="/" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
        ← {detail.backToConsole}
      </Link>
      <div className="mb-6 mt-2 flex items-center justify-between">
        <h1 className="text-2xl font-bold">{suppliersT.title}</h1>
        <Link href="/suppliers/new" className={buttonVariants({})}>
          {suppliersT.add}
        </Link>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          {suppliersT.none}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((s) => (
            <li key={s.id} className="rounded-xl border bg-card p-4 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-base font-semibold">{s.name}</span>
                  {!s.active ? <Badge variant="outline">{suppliersT.inactive}</Badge> : null}
                  <Badge variant={s.acceptsSoloHalfDay ? "secondary" : "overdue"}>
                    {s.acceptsSoloHalfDay ? suppliersT.soloOk : suppliersT.fullDayOnly}
                  </Badge>
                </div>
                <Link
                  href={`/suppliers/${s.id}/edit`}
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                >
                  {suppliersT.edit}
                </Link>
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                <span>{s.capabilities.map((c) => shootTypeLabels[c] ?? c).join(" · ")}</span>
                <span>{s.serviceRegions.map((r) => regionLabels[r] ?? r).join(" · ")}</span>
                {s.phone ? <span dir="ltr">{s.phone}</span> : null}
                {s.deliverableSlaDays ? (
                  <span>
                    {suppliersT.slaOverride}: {s.deliverableSlaDays}
                  </span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
