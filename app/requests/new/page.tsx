import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { submitRequestAction } from "@/app/actions";
import { RequestForm } from "@/components/request-form";
import { db } from "@/db/client";
import { clients } from "@/db/schema";
import { detail, form as t } from "@/lib/i18n/he";

export const dynamic = "force-dynamic";

export default async function NewRequestPage() {
  const clientRows = await db()
    .select({ id: clients.id, name: clients.name })
    .from(clients)
    .where(eq(clients.status, "ACTIVE"))
    .orderBy(asc(clients.name));

  return (
    <main className="mx-auto max-w-2xl px-4 py-6">
      <Link href="/" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
        ← {detail.backToConsole}
      </Link>
      <h1 className="mt-2 text-2xl font-bold">{t.title}</h1>
      <p className="mb-6 mt-1 text-sm text-muted-foreground">{t.subtitle}</p>
      <RequestForm clients={clientRows} action={submitRequestAction} submitLabel={t.submit} />
    </main>
  );
}
