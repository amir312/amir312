import { BRIEF_FIELD_KEYS, type BriefContent } from "@/lib/brief/templates";
import { briefFields } from "@/lib/i18n/he";

/** Read-only rendering of brief content — client approval page, supplier view, request page. */
export function BriefContentView({ content }: { content: BriefContent }) {
  const filled = BRIEF_FIELD_KEYS.filter((k) => content[k]);
  return (
    <dl className="flex flex-col gap-3">
      {filled.map((key) => (
        <div key={key}>
          <dt className="text-xs font-semibold text-muted-foreground">{briefFields[key]}</dt>
          <dd className="whitespace-pre-wrap text-sm">{content[key]}</dd>
        </div>
      ))}
    </dl>
  );
}
