import { BriefApprovalForm } from "@/components/brief-approval-form";
import { BriefContentView } from "@/components/brief-content";
import { ChooseDateForm } from "@/components/choose-date-form";
import { db } from "@/db/client";
import { briefT, chooseT, shortDate } from "@/lib/i18n/he";
import { getBriefApprovalPage } from "@/lib/services/briefs";
import { getChoicePage } from "@/lib/services/matching";
import { peekTokenPurpose } from "@/lib/tokens";

export const dynamic = "force-dynamic";

function CenteredNote({ title, body, emoji }: { title: string; body?: string; emoji?: string }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-2 px-6 text-center">
      {emoji ? <div className="text-3xl">{emoji}</div> : null}
      <h1 className="text-xl font-bold">{title}</h1>
      {body ? <p className="text-sm text-muted-foreground">{body}</p> : null}
    </main>
  );
}

// Mobile-first, no account. One client link route, purpose-dispatched:
// CHOOSE_DATE (pick the held date) or APPROVE_BRIEF (approve / ask changes).
export default async function ClientLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const purpose = await peekTokenPurpose(db(), token);

  if (purpose === "APPROVE_BRIEF") return <BriefApprovalPage token={token} />;
  return <ChooseDatePage token={token} />;
}

async function ChooseDatePage({ token }: { token: string }) {
  const result = await getChoicePage(token);

  if (!result.ok) {
    // A used link reports its outcome — the no-JS confirm lands here.
    if (result.reason === "USED" && result.finalState?.outcome === "CONFIRMED") {
      return (
        <CenteredNote
          emoji="📸"
          title={chooseT.confirmedTitle}
          body={chooseT.confirmedBody(
            result.finalState.date ? shortDate(result.finalState.date) : "",
          )}
        />
      );
    }
    if (result.reason === "USED" && result.finalState?.outcome === "DECLINED") {
      return <CenteredNote title={chooseT.declinedTitle} body={chooseT.declinedBody} />;
    }
    const used = result.reason === "USED";
    return (
      <CenteredNote
        title={used ? chooseT.alreadyUsedTitle : chooseT.invalidTitle}
        body={used ? chooseT.alreadyUsedBody : chooseT.invalidBody}
      />
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

async function BriefApprovalPage({ token }: { token: string }) {
  const result = await getBriefApprovalPage(token);

  if (!result.ok) {
    if (result.reason === "USED" && result.finalState?.outcome === "APPROVED") {
      return <CenteredNote emoji="🎬" title={briefT.approvedTitle} body={briefT.approvedBody} />;
    }
    if (result.reason === "USED" && result.finalState?.outcome === "CHANGES") {
      return <CenteredNote title={briefT.changesTitle} body={briefT.changesBody} />;
    }
    if (result.reason === "USED") {
      return <CenteredNote title={briefT.alreadyDoneTitle} body={briefT.alreadyDoneBody} />;
    }
    return <CenteredNote title={chooseT.invalidTitle} body={chooseT.invalidBody} />;
  }

  return (
    <main className="mx-auto max-w-md px-4 py-8">
      <h1 className="text-xl font-bold">{briefT.approveHello(result.page.clientName)}</h1>
      <p className="mb-4 mt-1 text-sm text-muted-foreground">
        {briefT.approveExplain(shortDate(result.page.shootDate))}
      </p>
      <div className="mb-6 rounded-lg border p-4">
        <BriefContentView content={result.page.content} />
      </div>
      <BriefApprovalForm token={token} />
    </main>
  );
}
