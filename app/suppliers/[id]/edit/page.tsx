import Link from "next/link";
import { notFound } from "next/navigation";
import { saveSupplierAction } from "@/app/actions";
import { SupplierForm } from "@/components/supplier-form";
import { getSupplier } from "@/lib/services/suppliers";
import { suppliersT } from "@/lib/i18n/he";
import type { SupplierActionState } from "@/app/actions";

export const dynamic = "force-dynamic";

export default async function EditSupplierPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supplier = await getSupplier(id);
  if (!supplier) notFound();

  async function action(prev: SupplierActionState, fd: FormData) {
    "use server";
    return saveSupplierAction(id, prev, fd);
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-6">
      <Link href="/suppliers" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
        ← {suppliersT.title}
      </Link>
      <h1 className="mb-6 mt-2 text-2xl font-bold">
        {suppliersT.edit} — {supplier.name}
      </h1>
      <SupplierForm supplier={supplier} action={action} />
    </main>
  );
}
