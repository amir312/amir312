import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  console_,
  exceptionHeadline,
  ownerLabels,
  severityLabels,
  suggestionLabels,
  shootTypeLabels,
} from "@/lib/i18n/he";
import type { ExceptionItem } from "@/lib/services/console";
import { SuggestionButton } from "./suggestion-button";

const SEVERITY_EDGE: Record<ExceptionItem["severity"], string> = {
  ESCALATED: "border-s-sev-escalated",
  OVERDUE: "border-s-sev-overdue",
  AT_RISK: "border-s-muted-foreground",
};

const SEVERITY_BADGE: Record<ExceptionItem["severity"], "escalated" | "overdue" | "secondary"> = {
  ESCALATED: "escalated",
  OVERDUE: "overdue",
  AT_RISK: "secondary",
};

export function ExceptionCard({ item }: { item: ExceptionItem }) {
  const headline = item.incidentSummary ?? exceptionHeadline(item.status, item.action);
  const labels = suggestionLabels[item.suggestion.key];
  const who = item.ownerType
    ? `${ownerLabels[item.ownerType]}${item.ownerName ? ` · ${item.ownerName}` : ""}`
    : null;

  const contextBits = [
    item.clientName,
    item.shootType ? shootTypeLabels[item.shootType] : null,
    item.supplierName && item.supplierName !== item.clientName ? item.supplierName : null,
  ].filter(Boolean);

  return (
    <div
      className={`rounded-xl border bg-card shadow-sm border-s-4 ${SEVERITY_EDGE[item.severity]} p-4 flex flex-col gap-2`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold leading-snug">{headline}</div>
          <div className="mt-1 text-sm text-muted-foreground truncate">
            {contextBits.join(" · ")}
            {who ? (
              <>
                {contextBits.length > 0 ? " · " : ""}
                {console_.heldBy} {who}
              </>
            ) : null}
            {" · "}
            <span className="font-medium text-foreground/70">
              {console_.stuckDays(item.daysStuck)}
            </span>
          </div>
        </div>
        <Badge variant={SEVERITY_BADGE[item.severity]} className="shrink-0">
          {severityLabels[item.severity]}
        </Badge>
      </div>

      {labels.explain ? <p className="text-sm text-muted-foreground">{labels.explain}</p> : null}

      <div className="flex items-center gap-3 pt-1">
        {item.suggestion.kind === "navigate" ? (
          item.shootRequestId ? (
            <Link
              href={`/requests/${item.shootRequestId}`}
              className={buttonVariants({ variant: "default", size: "sm" })}
            >
              {labels.button}
            </Link>
          ) : null
        ) : (
          <SuggestionButton
            suggestionKey={item.suggestion.key}
            label={labels.button}
            requestId={item.shootRequestId}
            incidentId={item.incidentId}
          />
        )}
        {item.shootRequestId && item.suggestion.kind !== "navigate" ? (
          <Link
            href={`/requests/${item.shootRequestId}`}
            className="text-sm text-muted-foreground underline-offset-4 hover:underline"
          >
            {console_.openRequest}
          </Link>
        ) : null}
      </div>
    </div>
  );
}
