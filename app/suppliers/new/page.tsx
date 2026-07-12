import Link from "next/link";
import { saveSupplierAction } from "@/app/actions";
import { SupplierForm } from "@/components/supplier-form";
import { suppliersT } from "@/lib/i18n/he";
import type { SupplierActionState } from "@/app/actions";

export const dynamic = "force-dynamic";

export default function NewSupplierPage() {
  async function action(prev: SupplierActionState, fd: FormData) {
    "use server";
    return saveSupplierAction(null, prev, fd);
  }
  return (
    <main className="mx-auto max-w-2xl px-4 py-6">
      <Link href="/suppliers" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
        ← {suppliersT.title}
      </Link>
      <h1 className="mb-6 mt-2 text-2xl font-bold">{suppliersT.add}</h1>
      <SupplierForm action={action} />
    </main>
  );
}
