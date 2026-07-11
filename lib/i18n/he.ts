/**
 * ALL Hebrew UI strings live here. Never inline a Hebrew string in a component.
 * Identifiers stay English; the interface speaks plain Hebrew — an enum is
 * never surfaced to a user.
 */
import type { WorkflowEvent } from "@/lib/workflow/types";
import type { IncidentKind, NextAction, OwnerType, RequestStatus } from "@/lib/workflow/types";

export const appName = "ShootOps";

export const statusLabels: Record<RequestStatus, string> = {
  DRAFT: "טיוטה",
  MISSING_INFO: "חסרים פרטים",
  PENDING_MATCH: "ממתין לשיבוץ",
  OPTIONS_PROPOSED: "הצעת שיבוץ ממתינה לאישור",
  SOFT_HELD: "ממתין לבחירת מועד",
  CONFIRMED: "מועד אושר",
  BRIEF_PENDING: "בריף בהכנה",
  READY: "מוכן לצילום",
  SHOT: "צולם",
  AWAITING_DELIVERY: "ממתין לתוצרים",
  DELIVERED: "תוצרים התקבלו",
  COMPLETED: "הושלם",
  CANCELLED: "בוטל",
};

export const ownerLabels: Record<OwnerType, string> = {
  SOCIAL_MANAGER: "מנהל סושיאל",
  SUPPLIER: "צלם",
  CLIENT: "לקוח",
  COORDINATOR: "רכזת",
  SYSTEM: "מערכת",
};

export const actionLabels: Record<NextAction, string> = {
  COMPLETE_REQUEST: "להשלים פרטים חסרים",
  REVIEW_REQUEST: "לאשר את השיבוץ המוצע",
  GRANT_EXCEPTION: "להכריע בבקשת זכאות",
  FIND_SUPPLIER: "לאתר שיבוץ",
  SUBMIT_AVAILABILITY: "לעדכן זמינות",
  CHOOSE_DATE: "לבחור מועד",
  WRITE_BRIEF: "לכתוב את הבריף",
  APPROVE_BRIEF: "לאשר את הבריף",
  SEND_BRIEF_TO_SUPPLIER: "לשלוח את הבריף לצלם",
  CONFIRM_CLIENT_CONTACT: "לאשר תיאום מול הלקוח",
  RUN_SHOOT: "לבצע את הצילום",
  UPLOAD_DELIVERABLES: "להעלות תוצרים",
  FORWARD_DELIVERABLES: "להעביר את התוצרים",
  RESOLVE_INCIDENT: "לטפל בחריג",
  NONE: "—",
};

export const severityLabels: Record<string, string> = {
  ESCALATED: "דורש טיפול מיידי",
  OVERDUE: "באיחור",
  AT_RISK: "בסיכון",
};

/** Intake field labels — used both by the form and by VALIDATION_FAILED summaries. */
export const fieldLabels: Record<string, string> = {
  client_id: "לקוח",
  shoot_type: "סוג צילום",
  address: "כתובת הצילום",
  region_code: "אזור",
  onsite_contact_name: "איש קשר בשטח",
  onsite_contact_phone: "טלפון איש קשר",
  purpose: "מטרת הצילום",
  client_windows: "חלונות זמן של הלקוח",
  target_date: "תאריך יעד",
  flexibility: "גמישות",
};

function fieldList(fields: string[]): string {
  return fields.map((f) => fieldLabels[f] ?? f).join(", ");
}

const dateFmt = new Intl.DateTimeFormat("he-IL", { day: "numeric", month: "numeric" });

/** 2026-07-18 → ‎18.7 */
export function shortDate(isoDate: string): string {
  return dateFmt.format(new Date(`${isoDate}T00:00:00`));
}

function shortDateTime(d: Date): string {
  return new Intl.DateTimeFormat("he-IL", {
    day: "numeric",
    month: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Jerusalem",
  }).format(d);
}

/** One Hebrew line per workflow event — rendered directly in the unified timeline. */
export function eventSummary(event: WorkflowEvent): string {
  switch (event.kind) {
    case "REQUEST_SUBMITTED":
      return "הבקשה הוגשה ונכנסה לתור השיבוץ";
    case "VALIDATION_FAILED":
      return `הבקשה הוחזרה להשלמה — חסרים: ${fieldList(event.missingFields)}`;
    case "ELIGIBILITY_FLAGGED":
      return event.eligibility === "NOT_ELIGIBLE"
        ? "אין זכאות פנויה — הועבר לרכזת להכרעה"
        : "נדרשת בדיקת זכאות — הועבר לרכזת";
    case "EXCEPTION_GRANTED":
      return "אושרה חריגת זכאות — הבקשה חזרה לתור השיבוץ";
    case "MATCH_PROPOSED":
      return event.paired
        ? "המערכת הציעה שיבוץ מזווג — ממתין לאישור הרכזת"
        : "המערכת הציעה שיבוץ — ממתין לאישור הרכזת";
    case "COORDINATOR_APPROVED_MATCH":
      return "הרכזת אישרה את השיבוץ — נשלחות הצעות מועד";
    case "HOLD_PLACED":
      return `יום הצלם נשמר זמנית עד ${shortDateTime(event.heldUntil)} — ממתין לבחירת מועד`;
    case "CLIENT_CONFIRMED":
      return event.confirmedBy === "SOCIAL_MANAGER"
        ? `מנהל הסושיאל אישר מועד — ${shortDate(event.pairing.shootDate)}`
        : `הלקוח אישר מועד — ${shortDate(event.pairing.shootDate)}`;
    case "CLIENT_DECLINED":
      return "אף מועד לא התאים ללקוח — הבקשה חזרה לתור השיבוץ";
    case "HOLD_EXPIRED":
      return "פג תוקף השמירה ללא מענה — הבקשה חזרה לתור השיבוץ";
    case "PAIR_PARTNER_CONFIRMED":
      return "הלקוח השני ביום המזווג אישר את המועד";
    case "PAIR_PARTNER_DECLINED":
      return "הלקוח השני ביום המזווג ירד — השיבוץ הזה נשאר על כנו";
    case "BRIEF_STARTED":
      return "נפתחה משימת בריף עם דדליין";
    case "BRIEF_SENT_TO_CLIENT":
      return "הבריף נשלח לאישור הלקוח";
    case "BRIEF_APPROVED":
      return "הבריף אושר — הגרסה ננעלה";
    case "BRIEF_CHANGES_REQUESTED":
      return event.feedback ? `הלקוח ביקש שינויים בבריף — ${event.feedback}` : "הלקוח ביקש שינויים בבריף";
    case "BRIEF_SENT_TO_SUPPLIER":
      return "הבריף המאושר נשלח לצלם";
    case "T1_CONFIRMED":
      return "הצלם אישר שתיאם מול הלקוח";
    case "T1_MISSED":
      return "הצלם לא אישר תיאום מול הלקוח עד הדדליין — דורש טיפול";
    case "SHOOT_COMPLETED":
      return "הצילום בוצע — נפתח מעקב מסירת תוצרים";
    case "DELIVERABLES_UPLOADED":
      return "הצלם העלה קישור לתוצרים";
    case "DELIVERABLES_OVERDUE":
      return "התוצרים באיחור — דורש טיפול";
    case "DELIVERABLES_FORWARDED":
      return event.forwardedTo === "SOCIAL_MANAGER"
        ? "התוצרים הועברו למנהל הסושיאל"
        : "התוצרים הועברו ללקוח";
    case "REQUEST_CLOSED":
      return "הבקשה הושלמה — הזכאות נוצלה";
    case "CLIENT_CANCELLED":
      return event.reason ? `הלקוח ביטל את הצילום — ${event.reason}` : "הלקוח ביטל את הצילום";
    case "SUPPLIER_CANCELLED":
      return event.reason
        ? `הצלם ביטל — ${event.reason}. הבקשה חזרה לתור השיבוץ`
        : "הצלם ביטל — הבקשה חזרה לתור השיבוץ";
  }
}

/** One Hebrew line per incident — rendered directly in the exceptions console. */
export function incidentSummary(
  kind: IncidentKind,
  ctx: { supplierName?: string | null; shootDate?: string | null; region?: string | null; clientName?: string | null },
): string {
  const day = [ctx.supplierName, ctx.shootDate ? shortDate(ctx.shootDate) : null, ctx.region]
    .filter(Boolean)
    .join(", ");
  switch (kind) {
    case "HALF_DAY_FREE":
      return `חצי יום פנוי — ${day}`;
    case "SOLO_DAY_DECISION":
      return `נדרשת הכרעה — נשאר לקוח יחיד ביום של ${day}: למצוא לקוח חלופי או לאשר תוספת יום בודד`;
    case "CLIENT_CANCEL":
      return ctx.clientName ? `הלקוח ${ctx.clientName} ביטל צילום${day ? ` — ${day}` : ""}` : `לקוח ביטל צילום${day ? ` — ${day}` : ""}`;
    case "SUPPLIER_CANCEL":
      return `הצלם ביטל יום צילום${day ? ` — ${day}` : ""}`;
  }
}
