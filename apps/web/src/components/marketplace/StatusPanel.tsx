"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { Link } from "@/i18n/navigation";
import { shortDate } from "@/lib/marketplace/format";
import { checkFile, DOC_KINDS } from "@/lib/marketplace/upload";
import type { ApplicantMe } from "@/lib/marketplace/types";
import { SignIn } from "./SignIn";
import { useApplicant } from "./useApplicant";

const STEPS = ["identity", "qualification", "interview", "probation"] as const;
const EDITABLE = new Set(["applied", "kyc_submitted"]);

/** Applicant status: verification steps and KYC document upload (streamed to the API). */
export function StatusPanel() {
  const t = useTranslations("market.status");
  const { state, reload } = useApplicant();
  if (state.kind === "loading") return <p className="text-muted">{t("loading")}</p>;
  if (state.kind === "signed_out")
    return (
      <div className="space-y-3">
        <p>{t("signedOut")}</p>
        <SignIn onSignedIn={() => void reload()} />
      </div>
    );
  if (state.kind === "none")
    return (
      <p>
        {t("none")}{" "}
        <Link href="/astrologers/apply" className="font-medium text-accent underline">
          {t("applyLink")}
        </Link>
      </p>
    );
  if (state.kind === "error") return <p>{t("errors.generic")}</p>;
  return <Status me={state.me} reload={reload} />;
}

function Status({ me, reload }: { me: ApplicantMe; reload: () => Promise<void> }) {
  const t = useTranslations("market.status");
  const locale = useLocale() as "en" | "hi";
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const editable = EDITABLE.has(me.status);
  const step = (s: (typeof STEPS)[number]) =>
    me.verifications.find((v) => v.step === s)?.status ?? "pending";
  const err = (c: unknown) =>
    t.has(`errors.${String(c)}`) ? t(`errors.${String(c)}`) : t("errors.generic");

  async function upload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const file = fd.get("file");
    if (!(file instanceof File) || !file.size) return;
    const pre = checkFile(file);
    if (pre) return setMsg(err(pre));
    setBusy(true);
    setMsg(t("uploading"));
    try {
      const res = await fetch("/api/astrologer/documents", { method: "POST", body: fd });
      if (res.ok) {
        setMsg(t("uploaded"));
        form.reset();
        await reload();
      } else setMsg(err(((await res.json().catch(() => ({}))) as { code?: string }).code));
    } catch {
      setMsg(t("errors.generic"));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    const res = await fetch(`/api/astrologer/documents/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }).catch(() => null);
    if (res?.ok) await reload();
    else setMsg(t("errors.generic"));
  }

  return (
    <div className="space-y-6" data-testid="status-panel">
      <section className="rounded-md border border-border bg-surface p-5">
        <h2 className="text-sm font-medium text-muted">{t("current")}</h2>
        <p className="mt-1 text-lg font-semibold">{t(`statuses.${me.status}`)}</p>
        <h3 className="mt-4 text-sm font-medium">{t("steps")}</h3>
        <ol className="mt-2 space-y-1 text-sm">
          {STEPS.map((s, i) => (
            <li key={s} className="flex justify-between gap-3 border-b border-border py-1">
              <span>
                {i + 1}. {t(`step.${s}`)}
              </span>
              <span>{t(`stepStatus.${step(s)}`)}</span>
            </li>
          ))}
        </ol>
      </section>
      <section className="rounded-md border border-border bg-surface p-5">
        <h2 className="text-lg font-semibold">{t("documents")}</h2>
        <p className="mt-1 text-sm text-muted">{t("private")}</p>
        {me.documents.length === 0 ? (
          <p className="mt-3 text-sm">{t("noDocuments")}</p>
        ) : (
          <ul className="mt-3 space-y-2 text-sm">
            {me.documents.map((d) => (
              <li
                key={d.id}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-1"
              >
                <span>
                  {t(`kind.${d.kind}`)}: {d.filename} · {Math.ceil(d.size / 1024)} KB ·{" "}
                  {shortDate(d.uploaded_at, locale)}
                </span>
                {editable && (
                  <button
                    type="button"
                    onClick={() => void remove(d.id)}
                    className="py-1 underline"
                  >
                    {t("delete")}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {editable && (
          <form
            onSubmit={(e) => void upload(e)}
            className="mt-4 grid gap-3 sm:grid-cols-[12rem_1fr_auto] sm:items-end"
          >
            <label className="block text-sm font-medium">
              {t("kindLabel")}
              <select
                name="kind"
                defaultValue="identity"
                className="mt-1 w-full rounded-sm border border-border bg-surface px-3 py-2"
              >
                {DOC_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {t(`kind.${k}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm font-medium">
              {t("file")}
              <input
                name="file"
                type="file"
                required
                accept="application/pdf,image/jpeg,image/png"
                className="mt-1 block w-full text-sm"
              />
            </label>
            <button
              type="submit"
              disabled={busy}
              className="rounded-sm bg-primary px-4 py-2 font-medium text-primary-fg"
            >
              {t("uploadButton")}
            </button>
          </form>
        )}
        {editable && <p className="mt-3 text-sm text-muted">{t("needs")}</p>}
        <p aria-live="polite" className="mt-2 text-sm">
          {msg}
        </p>
      </section>
    </div>
  );
}
