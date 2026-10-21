"use client";

import { useState } from "react";
import {
  BirthFields,
  draftToInput,
  emptyBirth,
  type BirthDraft,
} from "@/components/forms/BirthFields";
import { computeFullKundli } from "@/lib/tools/actions";
import type { ActionResult, BirthInput, Dasha, Doshas, Kundli } from "@/lib/tools/types";
import { validateBirth } from "@/lib/tools/validate";
import { ErrorList, PrivacyNote, SubmitButton } from "./ErrorList";
import { KundliResult } from "./KundliResult";
import { useSubmit } from "./useSubmit";

type Full = {
  kundli: Kundli;
  dasha: ActionResult<Dasha>;
  doshas: ActionResult<Doshas>;
  birth: BirthInput;
};

export function KundliRunner() {
  const [draft, setDraft] = useState<BirthDraft>(emptyBirth);
  const { pending, result, errors, submit } = useSubmit<Full>();
  return (
    <div className="space-y-8">
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const birth = draftToInput(draft);
          submit(
            async () => {
              if (!birth) return { ok: false, code: "place_required" };
              const r = await computeFullKundli(birth);
              return r.ok ? { ok: true, data: { ...r.data, birth } } : r;
            },
            birth ? validateBirth(birth) : ["place_required"],
          );
        }}
        className="max-w-2xl space-y-4"
      >
        <BirthFields
          value={draft}
          onChange={setDraft}
          errors={errors}
          askFold={errors.includes("ambiguous_local_time") || draft.fold !== undefined}
        />
        <ErrorList errors={errors} />
        <div className="flex flex-wrap items-center gap-4">
          <SubmitButton pending={pending} />
          <PrivacyNote />
        </div>
      </form>
      <div aria-live="polite">
        {result && (
          <KundliResult
            kundli={result.kundli}
            dasha={result.dasha}
            doshas={result.doshas}
            birth={result.birth}
          />
        )}
      </div>
    </div>
  );
}
