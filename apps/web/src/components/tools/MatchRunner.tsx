"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import {
  BirthFields,
  draftToInput,
  emptyBirth,
  type BirthDraft,
} from "@/components/forms/BirthFields";
import { computeMatch } from "@/lib/tools/actions";
import type { Match } from "@/lib/tools/types";
import { validateBirth } from "@/lib/tools/validate";
import { ErrorList, PrivacyNote, SubmitButton } from "./ErrorList";
import { MatchResult } from "./MatchResult";
import { useSubmit } from "./useSubmit";

export function MatchRunner() {
  const tf = useTranslations("toolsUi.form");
  const [a, setA] = useState<BirthDraft>(emptyBirth);
  const [b, setB] = useState<BirthDraft>(emptyBirth);
  const { pending, result, errors, submit } = useSubmit<Match>();
  return (
    <div className="space-y-8">
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const pa = draftToInput(a);
          const pb = draftToInput(b);
          const local = [
            ...(pa ? validateBirth(pa) : ["place_required"]),
            ...(pb ? validateBirth(pb) : ["place_required"]),
          ];
          submit(
            async () => (pa && pb ? computeMatch(pa, pb) : { ok: false, code: "place_required" }),
            [...new Set(local)],
          );
        }}
        className="space-y-4"
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <BirthFields value={a} onChange={setA} legend={tf("partner1")} errors={errors} />
          <BirthFields value={b} onChange={setB} legend={tf("partner2")} errors={errors} />
        </div>
        <ErrorList errors={errors} />
        <div className="flex flex-wrap items-center gap-4">
          <SubmitButton pending={pending} />
          <PrivacyNote />
        </div>
      </form>
      <div aria-live="polite">{result && <MatchResult match={result} />}</div>
    </div>
  );
}
