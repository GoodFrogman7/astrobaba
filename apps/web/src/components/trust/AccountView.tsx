"use client";

import type { ConsentState, DataExport, Locale } from "@astro/shared";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useId, useState } from "react";
import { SignIn } from "@/components/marketplace/SignIn";
import { Link } from "@/i18n/navigation";
import { call } from "@/lib/billing/client";
import { dateTimeIst, shortDate } from "@/lib/marketplace/format";
import {
  cancelDeletion,
  confirmMatches,
  exportDownloadHref,
  exportsPending,
  loadDeletion,
  loadExports,
  loadMe,
  requestDeletion,
  requestExport,
  type DeletionState,
  type ExportOutcome,
} from "@/lib/trust/account";
import {
  requestConsent,
  stripSignedIn,
  type ConsentsResponse,
  type Fetcher,
} from "@/lib/trust/consent";
import type { DeletionRequest, Me } from "@/lib/trust/types";
import { CONSENTS_CHANGED } from "./ConsentGate";

const fetcher = call as Fetcher;
const EXPORT_POLL_MS = 5000;

/**
 * /account (private): profile summary, consents with versions and dates, "Download my data"
 * and "Delete my account" (docs/api/trust.md §1–2). Everything loads in the browser because it
 * sits behind the httpOnly session cookie.
 */
export function AccountView() {
  const t = useTranslations("trust.account");
  const [me, setMe] = useState<Me | "signin" | null | undefined>(undefined);
  const [consents, setConsents] = useState<ConsentState | null>(null);

  const load = useCallback(async () => {
    const [m, c] = await Promise.all([
      loadMe(fetcher),
      fetcher<ConsentsResponse>("/api/me/consents"),
    ]);
    setMe(m);
    setConsents(c.ok && c.data.signed_in ? stripSignedIn(c.data) : null);
  }, []);

  useEffect(() => {
    void Promise.resolve().then(load);
    const again = () => void load();
    window.addEventListener(CONSENTS_CHANGED, again);
    return () => window.removeEventListener(CONSENTS_CHANGED, again);
  }, [load]);

  if (me === undefined) return <p className="text-muted">{t("loading")}</p>;
  if (me === "signin")
    return (
      <div className="space-y-3">
        <p>{t("signIn")}</p>
        <SignIn source="account" onSignedIn={() => void load()} />
      </div>
    );
  if (me === null)
    return (
      <div role="alert" className="space-y-3">
        <p>{t("error")}</p>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-sm border border-border px-4 py-2 text-sm"
        >
          {t("retry")}
        </button>
      </div>
    );

  return (
    <div className="space-y-10">
      <ProfileSummary me={me} />
      <ConsentSummary consents={consents} onReview={() => void requestConsent()} />
      <ExportSection />
      <DeletionSection />
    </div>
  );
}

const card = "space-y-3 rounded-md border border-border bg-surface p-5";

export function ProfileSummary({ me }: { me: Me }) {
  const t = useTranslations("trust.account");
  const locale = useLocale() as Locale;
  const lang = me.locale === "en" || me.locale === "hi" ? me.locale : null;
  return (
    <section aria-labelledby="acc-profile" className={card}>
      <h2 id="acc-profile" className="text-xl font-semibold">
        {t("profile")}
      </h2>
      <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[12rem_1fr]">
        <dt className="text-muted">{t("phone")}</dt>
        <dd className="tabular-nums" data-testid="acc-phone">
          {me.phone}
        </dd>
        {me.created_at && (
          <>
            <dt className="text-muted">{t("since")}</dt>
            <dd>{shortDate(me.created_at, locale)}</dd>
          </>
        )}
        {lang && (
          <>
            <dt className="text-muted">{t("language")}</dt>
            <dd>{t(`languages.${lang}`)}</dd>
          </>
        )}
        {me.astrologer && (
          <>
            <dt className="text-muted">{t("astrologer")}</dt>
            <dd>{me.astrologer.status}</dd>
          </>
        )}
      </dl>
      <h3 className="pt-2 font-semibold">{t("links")}</h3>
      <p className="flex flex-wrap gap-x-4 text-sm">
        <Link href="/wallet" className="text-accent underline">
          {t("wallet")}
        </Link>
        <Link href="/account/reports" className="text-accent underline">
          {t("reports")}
        </Link>
      </p>
    </section>
  );
}

export function ConsentSummary({
  consents,
  onReview,
}: {
  consents: ConsentState | null;
  onReview: () => void;
}) {
  const t = useTranslations("trust.account");
  const locale = useLocale() as Locale;
  return (
    <section aria-labelledby="acc-consents" className={card} data-testid="acc-consents">
      <h2 id="acc-consents" className="text-xl font-semibold">
        {t("consents")}
      </h2>
      {consents && consents.accepted.length > 0 ? (
        <ul className="space-y-1">
          {consents.accepted.map((a) => (
            <li key={`${a.kind}-${a.version}-${a.accepted_at}`}>
              <span className="font-medium">{t(`kinds.${a.kind}`)}</span>{" "}
              <span className="text-muted">
                ({t("acceptedOn", { version: a.version, date: dateTimeIst(a.accepted_at, locale) })}
                )
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p>{t("consentsNone")}</p>
      )}
      {consents && (
        <p className="text-sm">
          {consents.current
            ? t("consentsCurrent", { version: consents.version })
            : t("consentsOld", { version: consents.version })}
        </p>
      )}
      {consents && !consents.current && (
        <button
          type="button"
          onClick={onReview}
          className="rounded-sm bg-primary px-4 py-2 font-medium text-primary-fg"
        >
          {t("review")}
        </button>
      )}
    </section>
  );
}

function ExportSection() {
  const t = useTranslations("trust.account.export");
  const [items, setItems] = useState<DataExport[] | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ExportOutcome | null>(null);

  const refresh = useCallback(async () => {
    const list = await loadExports(fetcher);
    setItems(Array.isArray(list) ? list : null);
  }, []);

  useEffect(() => {
    void Promise.resolve().then(refresh);
  }, [refresh]);

  const pending = Array.isArray(items) && exportsPending(items);
  useEffect(() => {
    if (!pending) return;
    const id = setInterval(() => void refresh(), EXPORT_POLL_MS);
    return () => clearInterval(id);
  }, [pending, refresh]);

  async function ask() {
    setBusy(true);
    const r = await requestExport(fetcher);
    setBusy(false);
    setOutcome(r);
    if (r.kind === "queued") setItems((list) => [r.item, ...(list ?? [])]);
  }

  return (
    <section aria-labelledby="acc-export" className={card}>
      <h2 id="acc-export" className="text-xl font-semibold">
        {t("heading")}
      </h2>
      <p>{t("body")}</p>
      <button
        type="button"
        disabled={busy}
        onClick={() => void ask()}
        className="rounded-sm bg-primary px-4 py-2 font-medium text-primary-fg disabled:opacity-60"
        data-testid="export-request"
      >
        {busy ? t("busy") : t("button")}
      </button>
      <ExportMessage outcome={outcome} />
      <h3 className="pt-2 font-semibold">{t("list")}</h3>
      {items === undefined ? null : <ExportList items={items ?? []} />}
    </section>
  );
}

export function ExportMessage({ outcome }: { outcome: ExportOutcome | null }) {
  const t = useTranslations("trust.account");
  if (!outcome) return <p aria-live="polite" className="text-sm" />;
  const text =
    outcome.kind === "queued"
      ? t("export.queued")
      : outcome.kind === "tooSoon"
        ? t("export.tooSoon")
        : outcome.kind === "signin"
          ? t("deletion.errors.signin")
          : t(`deletion.errors.${outcome.key}`);
  return (
    <p aria-live="polite" className="text-sm" data-testid="export-message">
      {text}
    </p>
  );
}

export function ExportList({ items }: { items: DataExport[] }) {
  const t = useTranslations("trust.account.export");
  const locale = useLocale() as Locale;
  if (!items.length) return <p className="text-sm text-muted">{t("none")}</p>;
  return (
    <ul className="divide-y divide-border" data-testid="export-list">
      {items.map((e) => {
        const href = exportDownloadHref(e);
        return (
          <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span>
              <span className="font-medium">{t(`status.${e.status}`)}</span>{" "}
              <span className="text-sm text-muted">
                {t("requested", { date: dateTimeIst(e.created_at, locale) })}
              </span>
              {e.status === "failed" && (
                <span className="block text-sm text-muted">{t("failedHelp")}</span>
              )}
            </span>
            {href && (
              <a href={href} download className="text-accent underline">
                {t("download")}
              </a>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function DeletionSection() {
  const [request, setRequest] = useState<DeletionState | undefined>(undefined);
  const [notice, setNotice] = useState<"cancelled" | null>(null);

  const refresh = useCallback(async () => setRequest(await loadDeletion(fetcher)), []);
  useEffect(() => {
    void Promise.resolve().then(refresh);
  }, [refresh]);

  return (
    <DeletionPanel
      request={request}
      notice={notice}
      onRequested={(r) => {
        setNotice(null);
        setRequest(r);
      }}
      onCancelled={() => {
        setNotice("cancelled");
        setRequest("none");
      }}
    />
  );
}

/** What deletion removes and keeps (trust.md §2), then the form or the open request. */
export function DeletionPanel({
  request,
  notice = null,
  onRequested = () => undefined,
  onCancelled = () => undefined,
}: {
  request: DeletionState | undefined;
  notice?: "cancelled" | null;
  onRequested?: (r: DeletionRequest) => void;
  onCancelled?: () => void;
}) {
  const t = useTranslations("trust.account.deletion");
  const locale = useLocale() as Locale;
  const id = useId();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"confirm" | "signin" | "network" | "generic" | null>(null);
  const open = typeof request === "object";

  async function submit() {
    setError(null);
    if (!confirmMatches(text)) return setError("confirm");
    setBusy(true);
    const r = await requestDeletion(text, fetcher);
    setBusy(false);
    if (r.kind === "requested") onRequested(r.request);
    else if (r.kind === "invalid") setError("confirm");
    else if (r.kind === "signin") setError("signin");
    else if (r.kind === "error") setError(r.key);
  }

  async function cancel() {
    setError(null);
    setBusy(true);
    const r = await cancelDeletion(fetcher);
    setBusy(false);
    if (r.kind === "cancelled") onCancelled();
    else if (r.kind === "signin") setError("signin");
    else if (r.kind === "error") setError(r.key);
  }

  return (
    <section aria-labelledby="acc-delete" className={card} data-testid="acc-deletion">
      <h2 id="acc-delete" className="text-xl font-semibold">
        {t("heading")}
      </h2>
      <p>{t("body")}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <h3 className="font-semibold">{t("deletedHeading")}</h3>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
            {(t.raw("deleted") as string[]).map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="font-semibold">{t("keptHeading")}</h3>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
            {(t.raw("kept") as string[]).map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
      </div>
      <p className="text-sm text-muted">{t("again")}</p>

      {notice === "cancelled" && (
        <p role="status" data-testid="deletion-cancelled">
          {t("cancelled")}
        </p>
      )}

      {open ? (
        <div
          className="space-y-2 rounded-md border-2 border-accent p-4"
          data-testid="deletion-pending"
        >
          <h3 className="font-semibold">{t("pendingHeading")}</h3>
          <p>
            {(request.requested_at ?? request.created_at)
              ? t("pending", {
                  date: dateTimeIst(String(request.requested_at ?? request.created_at), locale),
                })
              : t("pendingNoDate")}
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void cancel()}
            className="rounded-sm border border-border px-4 py-2 font-medium disabled:opacity-60"
          >
            {t("cancel")}
          </button>
        </div>
      ) : request === "none" ? (
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="space-y-2"
          data-testid="deletion-form"
        >
          <label htmlFor={`${id}-confirm`} className="block font-medium">
            {t("confirmLabel")}
          </label>
          <input
            id={`${id}-confirm`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            aria-invalid={error === "confirm" || undefined}
            aria-describedby={error ? `${id}-err` : undefined}
            className="w-full max-w-xs rounded-sm border border-border bg-bg px-3 py-2 font-mono"
          />
          <div>
            <button
              type="submit"
              disabled={busy}
              className="rounded-sm px-4 py-2 font-medium text-primary-fg disabled:opacity-60"
              style={{ background: "var(--color-danger)" }}
            >
              {busy ? t("busy") : t("button")}
            </button>
          </div>
        </form>
      ) : null}
      <p id={`${id}-err`} role="alert" className="text-sm text-danger">
        {error ? t(`errors.${error}`) : ""}
      </p>
    </section>
  );
}
