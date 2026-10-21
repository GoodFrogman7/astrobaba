"use client";

import { useState } from "react";
import {
  BirthFields,
  draftToInput,
  emptyBirth,
  type BirthDraft,
} from "@/components/forms/BirthFields";
import { DobField, NameField } from "@/components/forms/SimpleForms";
import { computeDasha, computeDoshas, computeKundli, computeNumerology } from "@/lib/tools/actions";
import type { ToolForm, ToolKind } from "@/lib/tools/registry";
import type { ActionResult, Dasha, Doshas, Kundli, Numerology } from "@/lib/tools/types";
import { validateBirth, validateDob, validateName } from "@/lib/tools/validate";
import { ErrorList, PrivacyNote, SubmitButton } from "./ErrorList";
import {
  DashaResult,
  KaalSarpResult,
  MangalResult,
  NakshatraResult,
  NumberResult,
  SadeSatiResult,
  SunMoonAscendant,
  UnknownTimeNote,
} from "./Results";
import { useSubmit } from "./useSubmit";

type Output =
  | { kind: "kundli"; kundli: Kundli }
  | { kind: "dasha"; dasha: Dasha; tz: string; unknownTime: boolean }
  | { kind: "doshas"; doshas: Doshas; tz: string }
  | { kind: "numerology"; numerology: Numerology };

async function computeFor(
  slug: ToolKind,
  draft: BirthDraft,
  name: string,
  dob: string,
): Promise<ActionResult<Output>> {
  if (slug === "mulank" || slug === "destiny-number") {
    const r = await computeNumerology({ dateOfBirth: dob });
    return r.ok ? { ok: true, data: { kind: "numerology", numerology: r.data } } : r;
  }
  if (slug === "name-numerology") {
    const r = await computeNumerology({ name });
    return r.ok ? { ok: true, data: { kind: "numerology", numerology: r.data } } : r;
  }
  const birth = draftToInput(draft);
  if (!birth) return { ok: false, code: "place_required" };
  if (slug === "vimshottari-dasha") {
    const r = await computeDasha(birth);
    return r.ok
      ? {
          ok: true,
          data: {
            kind: "dasha",
            dasha: r.data,
            tz: birth.place.tz,
            unknownTime: birth.time === null,
          },
        }
      : r;
  }
  if (slug === "mangal-dosha" || slug === "sade-sati" || slug === "kaal-sarp-dosha") {
    const r = await computeDoshas(birth);
    return r.ok ? { ok: true, data: { kind: "doshas", doshas: r.data, tz: birth.place.tz } } : r;
  }
  const r = await computeKundli(birth);
  return r.ok ? { ok: true, data: { kind: "kundli", kundli: r.data } } : r;
}

function localErrors(slug: ToolKind, draft: BirthDraft, name: string, dob: string): string[] {
  if (slug === "mulank" || slug === "destiny-number") return validateDob(dob);
  if (slug === "name-numerology") return validateName(name);
  const b = draftToInput(draft);
  return b ? validateBirth(b) : ["place_required"];
}

/** Form + result for one /tools/[slug] page, driven by the registry's form type. */
export function ToolRunner({ slug, form }: { slug: ToolKind; form: ToolForm }) {
  const [draft, setDraft] = useState<BirthDraft>(emptyBirth);
  const [name, setName] = useState("");
  const [dob, setDob] = useState("");
  const { pending, result, errors, submit } = useSubmit<Output>();

  return (
    <div className="space-y-6">
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit(() => computeFor(slug, draft, name, dob), localErrors(slug, draft, name, dob));
        }}
        className="max-w-2xl space-y-4"
      >
        {form === "birth" && (
          <BirthFields
            value={draft}
            onChange={setDraft}
            showName={false}
            errors={errors}
            askFold={errors.includes("ambiguous_local_time") || draft.fold !== undefined}
          />
        )}
        {form === "numerology" && <NameField value={name} onChange={setName} />}
        {form === "dob" && <DobField value={dob} onChange={setDob} />}
        <ErrorList errors={errors} />
        <div className="flex flex-wrap items-center gap-4">
          <SubmitButton pending={pending} />
          <PrivacyNote />
        </div>
      </form>
      <div aria-live="polite">{result && <ToolOutput slug={slug} out={result} />}</div>
    </div>
  );
}

function ToolOutput({ slug, out }: { slug: ToolKind; out: Output }) {
  if (out.kind === "kundli") {
    return (
      <div className="space-y-4">
        <UnknownTimeNote kundli={out.kundli} />
        {slug === "nakshatra" ? (
          <NakshatraResult kundli={out.kundli} />
        ) : (
          <SunMoonAscendant kundli={out.kundli} />
        )}
      </div>
    );
  }
  if (out.kind === "dasha") return <DashaResult dasha={out.dasha} tz={out.tz} />;
  if (out.kind === "doshas") {
    const d = out.doshas;
    if (slug === "mangal-dosha")
      return <MangalResult mangal={d.mangal} reviewStatus={d.tables_review_status} />;
    if (slug === "kaal-sarp-dosha")
      return <KaalSarpResult ks={d.kaal_sarp} reviewStatus={d.tables_review_status} />;
    return <SadeSatiResult ss={d.sade_sati} tz={out.tz} reviewStatus={d.tables_review_status} />;
  }
  const kind =
    slug === "mulank" ? "mulank" : slug === "destiny-number" ? "bhagyank" : "name_number";
  return <NumberResult kind={kind} numerology={out.numerology} />;
}
