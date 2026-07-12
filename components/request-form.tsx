"use client";

import { useActionState } from "react";
import type { IntakeFormState } from "@/app/actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { fieldLabels, form as t } from "@/lib/i18n/he";
import { FLEXIBILITY, REGIONS, SHOOT_TYPES } from "@/lib/validation/request";

export interface RequestFormDefaults {
  clientId?: string | null;
  shootType?: string | null;
  address?: string | null;
  regionCode?: string | null;
  onsiteContactName?: string | null;
  onsiteContactPhone?: string | null;
  purpose?: string | null;
  clientWindows?: Array<{ from?: string; to?: string }>;
  needsBrief?: boolean;
  needsScript?: boolean;
  targetDate?: string | null;
  flexibility?: string | null;
  specialRequirements?: string | null;
  notes?: string | null;
}

export function RequestForm({
  clients,
  defaults = {},
  action,
  submitLabel,
  lockPrereqs = false,
}: {
  clients: Array<{ id: string; name: string }>;
  defaults?: RequestFormDefaults;
  action: (prev: IntakeFormState, fd: FormData) => Promise<IntakeFormState>;
  submitLabel: string;
  lockPrereqs?: boolean;
}) {
  const [state, formAction, pending] = useActionState<IntakeFormState, FormData>(action, {});
  const missing = new Set(state.missingFields ?? []);
  const invalid = (key: string) => (missing.has(key) ? true : undefined);
  const w = defaults.clientWindows ?? [];

  return (
    <form action={formAction} className="flex flex-col gap-5">
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {state.missingFields && state.missingFields.length > 0 ? (
        <Alert variant="warning">
          <AlertTitle>{t.missingTitle}</AlertTitle>
          <AlertDescription>
            {t.missingBody} {state.missingFields.map((f) => fieldLabels[f] ?? f).join(", ")}
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t.client}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="clientId">{t.client}</Label>
            <Select
              id="clientId"
              name="clientId"
              defaultValue={defaults.clientId ?? ""}
              disabled={lockPrereqs}
            >
              <option value="" disabled>
                {t.clientPlaceholder}
              </option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
            {lockPrereqs && defaults.clientId ? (
              <input type="hidden" name="clientId" value={defaults.clientId} />
            ) : null}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="shootType">{t.shootType}</Label>
            <Select
              id="shootType"
              name="shootType"
              defaultValue={defaults.shootType ?? "STILLS"}
              disabled={lockPrereqs}
            >
              {SHOOT_TYPES.map((st) => (
                <option key={st} value={st}>
                  {t.shootTypes[st]}
                </option>
              ))}
            </Select>
            {lockPrereqs && defaults.shootType ? (
              <input type="hidden" name="shootType" value={defaults.shootType} />
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t.sectionLocation}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="address">{t.address}</Label>
            <Input
              id="address"
              name="address"
              defaultValue={defaults.address ?? ""}
              aria-invalid={invalid("address")}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="regionCode">{t.region}</Label>
            <Select
              id="regionCode"
              name="regionCode"
              defaultValue={defaults.regionCode ?? ""}
              aria-invalid={invalid("region_code")}
            >
              <option value="">—</option>
              {REGIONS.map((r) => (
                <option key={r} value={r}>
                  {t.regions[r]}
                </option>
              ))}
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t.sectionContact}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="onsiteContactName">{t.contactName}</Label>
            <Input
              id="onsiteContactName"
              name="onsiteContactName"
              defaultValue={defaults.onsiteContactName ?? ""}
              aria-invalid={invalid("onsite_contact_name")}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="onsiteContactPhone">{t.contactPhone}</Label>
            <Input
              id="onsiteContactPhone"
              name="onsiteContactPhone"
              defaultValue={defaults.onsiteContactPhone ?? ""}
              dir="ltr"
              aria-invalid={invalid("onsite_contact_phone")}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t.sectionContent}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="purpose">{t.purpose}</Label>
            <Textarea
              id="purpose"
              name="purpose"
              placeholder={t.purposePlaceholder}
              defaultValue={defaults.purpose ?? ""}
              aria-invalid={invalid("purpose")}
            />
          </div>
          <div className="flex flex-wrap gap-6">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox name="needsBrief" defaultChecked={defaults.needsBrief ?? true} />
              {t.needsBrief}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox name="needsScript" defaultChecked={defaults.needsScript ?? false} />
              {t.needsScript}
            </label>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="specialRequirements">{t.specialRequirements}</Label>
            <Textarea
              id="specialRequirements"
              name="specialRequirements"
              placeholder={t.specialPlaceholder}
              defaultValue={defaults.specialRequirements ?? ""}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="notes">{t.notes}</Label>
            <Textarea id="notes" name="notes" defaultValue={defaults.notes ?? ""} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t.sectionWindows}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="window1From">{t.windowFrom}</Label>
            <Input
              id="window1From"
              name="window1From"
              type="date"
              defaultValue={w[0]?.from ?? ""}
              aria-invalid={invalid("client_windows")}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="window1To">{t.windowTo}</Label>
            <Input
              id="window1To"
              name="window1To"
              type="date"
              defaultValue={w[0]?.to ?? ""}
              aria-invalid={invalid("client_windows")}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="window2From" className="text-muted-foreground">
              {t.window2} — {t.windowFrom}
            </Label>
            <Input id="window2From" name="window2From" type="date" defaultValue={w[1]?.from ?? ""} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="window2To" className="text-muted-foreground">
              {t.window2} — {t.windowTo}
            </Label>
            <Input id="window2To" name="window2To" type="date" defaultValue={w[1]?.to ?? ""} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="targetDate">{t.targetDate}</Label>
            <Input id="targetDate" name="targetDate" type="date" defaultValue={defaults.targetDate ?? ""} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="flexibility">{t.flexibility}</Label>
            <Select id="flexibility" name="flexibility" defaultValue={defaults.flexibility ?? ""}>
              <option value="">—</option>
              {FLEXIBILITY.map((f) => (
                <option key={f} value={f}>
                  {t.flexibilityOptions[f]}
                </option>
              ))}
            </Select>
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button type="submit" size="lg" disabled={pending}>
          {pending ? "…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}
