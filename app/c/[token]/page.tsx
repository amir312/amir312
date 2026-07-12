import { ChooseDateForm } from "@/components/choose-date-form";
import { chooseT, shortDate } from "@/lib/i18n/he";
import { getChoicePage } from "@/lib/services/matching";

export const dynamic = "force-dynamic";

// Mobile-first, no account: the client (or their social manager) opens the
// one-shot link and picks a date. First to confirm, locks.
export default async function ChooseDatePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const result = await getChoicePage(token);

  if (!result.ok) {
    // A used link reports its outcome — the no-JS confirm lands here.
    if (result.reason === "USED" && result.finalState?.outcome === "CONFIRMED") {
      return (
        <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-2 px-6 text-center">
          <div className="text-3xl">📸</div>
          <h1 className="text-xl font-bold">{chooseT.confirmedTitle}</h1>
          <p className="text-sm text-muted-foreground">
            {chooseT.confirmedBody(result.finalState.date ? shortDate(result.finalState.date) : "")}
          </p>
        </main>
      );
    }
    if (result.reason === "USED" && result.finalState?.outcome === "DECLINED") {
      return (
        <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-2 px-6 text-center">
          <h1 className="text-xl font-bold">{chooseT.declinedTitle}</h1>
          <p className="text-sm text-muted-foreground">{chooseT.declinedBody}</p>
        </main>
      );
    }
    const used = result.reason === "USED";
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-2 px-6 text-center">
        <h1 className="text-xl font-bold">{used ? chooseT.alreadyUsedTitle : chooseT.invalidTitle}</h1>
        <p className="text-sm text-muted-foreground">
          {used ? chooseT.alreadyUsedBody : chooseT.invalidBody}
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-md px-4 py-8">
      <h1 className="text-xl font-bold">{chooseT.hello(result.page.clientName)}</h1>
      <p className="mb-6 mt-1 text-sm text-muted-foreground">{chooseT.explain}</p>
      <ChooseDateForm token={token} options={result.page.options} />
    </main>
  );
}
