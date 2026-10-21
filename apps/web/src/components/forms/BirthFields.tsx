"use client";

import { useTranslations } from "next-intl";
import { useId } from "react";
import type { BirthInput } from "@/lib/tools/types";
import { PlaceInput, type PlaceValue } from "./PlaceInput";

export interface BirthDraft {
  name: string;
  date: string;
  time: string;
  unknownTime: boolean;
  place: PlaceValue | null;
  fold?: 0 | 1;
}

export const emptyBirth = (): BirthDraft => ({
  name: "",
  date: "",
  time: "",
  unknownTime: false,
  place: null,
});

export function draftToInput(d: BirthDraft): BirthInput | null {
  if (!d.place) return null;
  return {
    ...(d.name.trim() ? { name: d.name.trim() } : {}),
    date: d.date,
    time: d.unknownTime ? null : d.time || null,
    place: d.place,
    ...(d.fold !== undefined ? { fold: d.fold } : {}),
  };
}

/** The birth details fieldset, reused by the single-person tools and by matchmaking. */
export function BirthFields({
  value,
  onChange,
  legend,
  showName = true,
  errors = [],
  askFold = false,
}: {
  value: BirthDraft;
  onChange: (v: BirthDraft) => void;
  legend?: string;
  showName?: boolean;
  errors?: string[];
  askFold?: boolean;
}) {
  const t = useTranslations("toolsUi.form");
  const id = useId();
  const set = (patch: Partial<BirthDraft>) => onChange({ ...value, ...patch });
  const has = (code: string) => errors.includes(code);
  return (
    <fieldset className="space-y-4 rounded-md border border-border bg-surface p-4">
      {legend && <legend className="px-1 font-semibold">{legend}</legend>}
      {showName && (
        <div>
          <label htmlFor={`${id}-name`} className="block text-sm font-medium">
            {t("name")}
          </label>
          <input
            id={`${id}-name`}
            type="text"
            maxLength={60}
            autoComplete="off"
            value={value.name}
            onChange={(e) => set({ name: e.target.value })}
            className="mt-1 w-full rounded-sm border border-border bg-surface px-3 py-2"
          />
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor={`${id}-date`} className="block text-sm font-medium">
            {t("date")}
          </label>
          <input
            id={`${id}-date`}
            type="date"
            required
            min="1800-01-02"
            max="2399-12-30"
            value={value.date}
            aria-invalid={has("date_invalid") || has("date_out_of_range") || undefined}
            onChange={(e) => set({ date: e.target.value })}
            className="mt-1 w-full rounded-sm border border-border bg-surface px-3 py-2"
          />
        </div>
        <div>
          <label htmlFor={`${id}-time`} className="block text-sm font-medium">
            {t("time")}
          </label>
          <input
            id={`${id}-time`}
            type="time"
            required={!value.unknownTime}
            disabled={value.unknownTime}
            value={value.time}
            aria-invalid={has("time_invalid") || undefined}
            onChange={(e) => set({ time: e.target.value, fold: undefined })}
            className="mt-1 w-full rounded-sm border border-border bg-surface px-3 py-2 disabled:opacity-50"
          />
          <label className="mt-2 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={value.unknownTime}
              onChange={(e) => set({ unknownTime: e.target.checked, fold: undefined })}
            />
            {t("unknownTime")}
          </label>
        </div>
      </div>
      <div>
        <label htmlFor={`${id}-place-input`} className="block text-sm font-medium">
          {t("place")}
        </label>
        <div className="mt-1">
          <PlaceInput
            inputId={`${id}-place-input`}
            value={value.place}
            onChange={(place) => set({ place, fold: undefined })}
            invalid={has("place_required")}
          />
        </div>
      </div>
      {askFold && (
        <fieldset className="space-y-1 text-sm">
          <legend>{t("foldQuestion")}</legend>
          <label className="mr-4 inline-flex items-center gap-2">
            <input
              type="radio"
              name={`${id}-fold`}
              checked={value.fold === 0}
              onChange={() => set({ fold: 0 })}
            />
            {t("foldFirst")}
          </label>
          <label className="inline-flex items-center gap-2">
            <input
              type="radio"
              name={`${id}-fold`}
              checked={value.fold === 1}
              onChange={() => set({ fold: 1 })}
            />
            {t("foldSecond")}
          </label>
        </fieldset>
      )}
    </fieldset>
  );
}
