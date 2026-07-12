/**
 * ALL Hebrew UI strings live here. Never inline a Hebrew string in a component.
 * Identifiers stay English; the interface speaks plain Hebrew — an enum is
 * never surfaced to a user.
 */
import type { WorkflowEvent } from "@/lib/workflow/types";
import type { IncidentKind, NextAction, OwnerType, RequestStatus } from "@/lib/workflow/types";
import type { SuggestionKey } from "@/lib/workflow/suggestions";

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

export const shootTypeLabels: Record<string, string> = {
  STILLS: "סטילס",
  VIDEO: "וידאו",
  CONTENT_CREATION: "יצירת תוכן",
};

export const severityLabels: Record<string, string> = {
  ESCALATED: "דורש טיפול מיידי",
  OVERDUE: "באיחור",
  AT_RISK: "בסיכון",
};

/** User-facing error lines (server actions render these verbatim). */
export const errors = {
  choosePrereqs: "בחרו לקוח וסוג צילום — בלעדיהם אין למה לפתוח בקשה",
  invalidAction: "הפעולה לא זוהתה — רעננו את המסך ונסו שוב",
  holdStillLive: "השמירה עדיין בתוקף — שלחו ללקוח תזכורת במקום לשחרר אותה",
};

/** Timeline annotations the services write directly (not via workflow events). */
export const timelineNotes = {
  reminderSent: (recipientName: string) => `נשלחה תזכורת אל ${recipientName}`,
  incidentResolved: (note?: string | null) => (note ? `החריג טופל — ${note}` : "החריג טופל"),
  eligibilityAutoOk: "זכאות אומתה — קיימת יתרה פנויה בחבילה",
};

/** Region codes are internal — users always see these. */
export const regionLabels: Record<string, string> = {
  TLV: "תל אביב והמרכז",
  SHARON: "השרון",
  SHFELA: "השפלה",
  JERUSALEM: "ירושלים והסביבה",
  HAIFA: "חיפה",
  SOUTH: "הדרום",
  NORTH: "הצפון",
};

export function regionLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  return regionLabels[code] ?? code;
}

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
  special_requirements: "דרישות מיוחדות",
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

/** Button label + one-line explanation per recommended action. */
export const suggestionLabels: Record<SuggestionKey, { button: string; explain: string }> = {
  RELEASE_EXPIRED_HOLD: {
    button: "שחרר את השמירה",
    explain: "השמירה פגה ללא מענה — שחרור יחזיר את הבקשה לתור השיבוץ ויפנה את יום הצלם",
  },
  APPROVE_MATCH: {
    button: "אשר את השיבוץ",
    explain: "הצעת שיבוץ ממתינה לאישורך — אישור ישמור את יום הצלם וישלח הצעות מועד",
  },
  GRANT_EXCEPTION: {
    button: "אשר חריגת זכאות",
    explain: "ללקוח אין זכאות פנויה — אישור יחזיר את הבקשה לתור השיבוץ",
  },
  MARK_T1_CONFIRMED: {
    button: "סמן: תואם מול הלקוח",
    explain: "הצלם לא אישר תיאום — אם וידאת טלפונית, סמני וזה ירד מהמסך",
  },
  MARK_SHOT: {
    button: "סמן שהצילום בוצע",
    explain: "יום הצילום עבר — סימון יפתח את מעקב מסירת התוצרים",
  },
  FORWARD_NOW: {
    button: "העבר את התוצרים",
    explain: "התוצרים התקבלו אך טרם הועברו — העברה תסגור את הבקשה ותנצל את הזכאות",
  },
  CLOSE_REQUEST: {
    button: "סגור את הבקשה",
    explain: "הכל הושלם — סגירה תנצל את הזכאות ותסיים את הטיפול",
  },
  REMIND_SUBMITTER: {
    button: "שלח תזכורת למגיש",
    explain: "הבקשה ממתינה להשלמת פרטים אצל המגיש",
  },
  REMIND_BRIEF_OWNER: {
    button: "שלח תזכורת על הבריף",
    explain: "הבריף מאחר — תזכורת לאחראי הבריף",
  },
  REMIND_CLIENT_BRIEF: {
    button: "שלח תזכורת ללקוח",
    explain: "הלקוח טרם אישר את הבריף",
  },
  REMIND_CLIENT_DATE: {
    button: "שלח תזכורת ללקוח",
    explain: "הלקוח טרם בחר מועד",
  },
  REMIND_SUPPLIER_DELIVERABLES: {
    button: "שלח תזכורת לצלם",
    explain: "התוצרים באיחור — תזכורת לצלם עם הדדליין",
  },
  RESOLVE_HALF_DAY: {
    button: "סמן כטופל",
    explain: "חצי יום התפנה — שבצי לקוח מחליף (מועמדים יוצגו כאן בפאזה הבאה) או סגרי את החריג",
  },
  RESOLVE_SOLO_DECISION: {
    button: "התקבלה החלטה — סגור",
    explain: "הצלם לא מקבל חצי יום בודד: מצאי לקוח מחליף או אשרי תוספת יום בודד — ההחלטה שלך",
  },
  RESOLVE_CANCELLATION: {
    button: "טופל — סגור חריג",
    explain: "ביטול דורש טיפול ידני — סגרי לאחר שההמשך סוכם",
  },
  RUN_MATCHER: {
    button: "פתח את הבקשה",
    explain: "אין עדיין שיבוץ — מנוע השיבוץ יציע מועמדים בפאזה הבאה",
  },
  OPEN_REQUEST: {
    button: "פתח את הבקשה",
    explain: "",
  },
};

/** "What happened" headline per (status, action) — the first line Noam reads. */
export function exceptionHeadline(status: string | null, action: string | null): string {
  const key = `${status}:${action}`;
  const map: Record<string, string> = {
    "MISSING_INFO:COMPLETE_REQUEST": "בקשה תקועה — חסרים פרטים מהמגיש",
    "PENDING_MATCH:FIND_SUPPLIER": "בקשה ממתינה לשיבוץ מעבר לזמן הסביר",
    "PENDING_MATCH:GRANT_EXCEPTION": "נדרשת הכרעת זכאות",
    "OPTIONS_PROPOSED:REVIEW_REQUEST": "הצעת שיבוץ ממתינה לאישורך",
    "OPTIONS_PROPOSED:NONE": "המערכת נתקעה בשמירת היום — נדרש טיפול",
    "SOFT_HELD:CHOOSE_DATE": "השמירה פגה — הלקוח לא בחר מועד",
    "CONFIRMED:WRITE_BRIEF": "הבריף מאחר",
    "BRIEF_PENDING:WRITE_BRIEF": "הבריף מאחר",
    "BRIEF_PENDING:APPROVE_BRIEF": "הלקוח לא אישר את הבריף",
    "BRIEF_PENDING:SEND_BRIEF_TO_SUPPLIER": "בריף מאושר שלא נשלח לצלם",
    "CONFIRMED:CONFIRM_CLIENT_CONTACT": "הצלם לא אישר תיאום מול הלקוח",
    "READY:CONFIRM_CLIENT_CONTACT": "הצלם לא אישר תיאום מול הלקוח",
    "READY:RUN_SHOOT": "יום הצילום עבר ולא עודכן",
    "AWAITING_DELIVERY:UPLOAD_DELIVERABLES": "התוצרים באיחור",
    "DELIVERED:FORWARD_DELIVERABLES": "תוצרים שהתקבלו ולא הועברו",
    "DELIVERED:NONE": "בקשה שהסתיימה ולא נסגרה",
  };
  return map[key] ?? "בקשה תקועה";
}

export const console_ = {
  title: "מה דורש טיפול",
  empty: "אין חריגים כרגע — הכל זורם",
  emptyUpcoming: "אין ימי צילום קרובים",
  upcomingTitle: "ימי צילום קרובים",
  today: "היום",
  tomorrow: "מחר",
  thisWeek: "השבוע הקרוב",
  stuckDays: (d: number) => (d < 1 ? "פחות מיום" : d < 2 ? "יום אחד" : `${Math.floor(d)} ימים`),
  heldBy: "אצל",
  openRequest: "פתח בקשה",
  newRequest: "בקשת צילום חדשה",
  reminderSent: "התזכורת נשלחה",
  reminderAlready: "כבר נשלחה תזכורת היום",
  done: "בוצע",
  actAs: "פועל בתור",
  greetingMorning: "בוקר טוב",
  greetingNoon: "צהריים טובים",
  greetingEvening: "ערב טוב",
  paired: "מזווג",
  halfDayFree: "חצי יום פנוי",
};

export const form = {
  title: "בקשת יום צילום",
  subtitle: "בקשה מלאה נכנסת ישירות לתור השיבוץ. בקשה חלקית תישמר ותחזור אליך להשלמה.",
  client: "לקוח",
  clientPlaceholder: "בחרו לקוח…",
  shootType: "סוג צילום",
  shootTypes: { STILLS: "סטילס", VIDEO: "וידאו", CONTENT_CREATION: "יצירת תוכן" } as Record<string, string>,
  sectionLocation: "מיקום הצילום",
  address: "כתובת מדויקת",
  region: "אזור",
  regions: regionLabels,
  sectionContact: "איש קשר בשטח",
  contactName: "שם",
  contactPhone: "טלפון",
  sectionContent: "מה מצלמים",
  purpose: "מטרת הצילום",
  purposePlaceholder: "למשל: צילומי מוצר לקמפיין קיץ, 12 מנות חדשות לתפריט…",
  needsBrief: "נדרש בריף",
  needsScript: "נדרש תסריט",
  specialRequirements: "דרישות מיוחדות",
  specialPlaceholder: "ציוד מיוחד, הכנות נדרשות, אנשים שחייבים להיות באתר…",
  notes: "הערות",
  sectionWindows: "מתי נוח ללקוח",
  windowFrom: "מתאריך",
  windowTo: "עד תאריך",
  window2: "חלון נוסף (רשות)",
  targetDate: "תאריך יעד (רשות)",
  flexibility: "גמישות הלקוח",
  flexibilityOptions: { HIGH: "גמיש", MEDIUM: "בינוני", LOW: "קשיח" } as Record<string, string>,
  submit: "שלח בקשה",
  resubmit: "שלח מחדש",
  missingTitle: "הבקשה נשמרה, אבל חסרים פרטים",
  missingBody: "היא לא תיכנס לשיבוץ עד שיושלמו:",
  submittedTitle: "הבקשה נשלחה לשיבוץ",
  flaggedTitle: "הבקשה נשמרה וממתינה לאישור זכאות",
  flaggedBody: "ללקוח אין זכאות פנויה — הרכזת תקבל את זה לטיפול",
  editTitle: "השלמת פרטי בקשה",
};

export const detail = {
  timeline: "ציר זמן",
  owner: "באחריות",
  action: "הפעולה הבאה",
  due: "דדליין",
  escalate: "הסלמה",
  eligibility: "זכאות",
  eligibilityLabels: {
    ELIGIBLE: "זכאי",
    NOT_ELIGIBLE: "אין זכאות",
    NEEDS_CHECK: "בבדיקה",
    EXCEPTION_GRANTED: "חריגה אושרה",
  } as Record<string, string>,
  backToConsole: "חזרה למסך הראשי",
};

/** One Hebrew line per incident — rendered directly in the exceptions console. */
export function incidentSummary(
  kind: IncidentKind,
  ctx: { supplierName?: string | null; shootDate?: string | null; region?: string | null; clientName?: string | null },
): string {
  const day = [ctx.supplierName, ctx.shootDate ? shortDate(ctx.shootDate) : null, regionLabel(ctx.region)]
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
