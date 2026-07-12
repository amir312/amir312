"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { SupplierActionState } from "@/app/actions";
import type { SupplierRow } from "@/lib/services/suppliers";
import { regionLabels, shootTypeLabels, suppliersT } from "@/lib/i18n/he";
import { REGIONS } from "@/lib/validation/request";
import { SHOOT_TYPES } from "@/lib/validation/supplier";

export function SupplierForm({
  supplier,
  action,
}: {
  supplier?: SupplierRow;
  action: (prev: SupplierActionState, fd: FormData) => Promise<SupplierActionState>;
}) {
  const [state, formAction, pending] = useActionState(action, {});

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <Card>
        <CardHeader>
          <CardTitle>{suppliersT.name}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="name">{suppliersT.name}</Label>
            <Input id="name" name="name" defaultValue={supplier?.name ?? ""} required minLength={2} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="phone">{suppliersT.phone}</Label>
            <Input id="phone" name="phone" dir="ltr" defaultValue={supplier?.phone ?? ""} />
          </div>
          <div className="grid gap-1.5 sm:col-span-2">
            <Label htmlFor="email">{suppliersT.email}</Label>
            <Input id="email" name="email" type="email" dir="ltr" defaultValue={supplier?.email ?? ""} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{suppliersT.capabilities}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-4">
          {SHOOT_TYPES.map((t) => (
            <label key={t} className="flex items-center gap-2 text-sm">
              <Checkbox
                name="capabilities"
                value={t}
                defaultChecked={supplier?.capabilities?.includes(t) ?? t === "STILLS"}
              />
              {shootTypeLabels[t]}
            </label>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{suppliersT.regions}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-4">
          {REGIONS.map((r) => (
            <label key={r} className="flex items-center gap-2 text-sm">
              <Checkbox
                name="serviceRegions"
                value={r}
                defaultChecked={supplier?.serviceRegions?.includes(r) ?? false}
              />
              {regionLabels[r]}
            </label>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="grid gap-4 pt-5 sm:grid-cols-2">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox name="acceptsSoloHalfDay" defaultChecked={supplier?.acceptsSoloHalfDay ?? true} />
            <span>
              {suppliersT.acceptsSoloHalfDay}
              <span className="block text-xs text-muted-foreground">{suppliersT.acceptsSoloExplain}</span>
            </span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox name="active" defaultChecked={supplier?.active ?? true} />
            {suppliersT.active}
          </label>
          <div className="grid gap-1.5">
            <Label htmlFor="deliverableSlaDays">{suppliersT.slaOverride}</Label>
            <Input
              id="deliverableSlaDays"
              name="deliverableSlaDays"
              type="number"
              min={1}
              max={30}
              placeholder={suppliersT.slaOverridePlaceholder}
              defaultValue={supplier?.deliverableSlaDays ?? ""}
            />
          </div>
        </CardContent>
      </Card>

      {state.error ? <p className="text-sm font-medium text-destructive">{state.error}</p> : null}
      <div>
        <Button type="submit" disabled={pending}>
          {suppliersT.save}
        </Button>
      </div>
    </form>
  );
}
