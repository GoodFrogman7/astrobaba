"use client";

import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { SignIn } from "@/components/marketplace/SignIn";
import { Link } from "@/i18n/navigation";
import { call } from "@/lib/billing/client";
import { dateTimeIst } from "@/lib/marketplace/format";
import { downloadHref, inProgress, watchReports } from "@/lib/revenue/reports";
import type { Report, ReportsResponse } from "@/lib/revenue/types";

type Load = "loading" | "signin" | "error" | "ready";

/**
 * /account/reports: the user's reports, newest first as the API returns them. While any report
 * is queued or rendering the list is re-read (3 s growing to 15 s, for up to 15 minutes);
 * nothing is polled once every report is ready or failed.
 */
export function ReportsList() {
  const t = useTranslations("revenue.account");
  const [items, setItems] = useState<Report[]>([]);
  const [state, setState] = useState<Load>("loading");
  const [stalled, setStalled] = useState(false);
  const run = useRef(0);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    const mine = ++run.current;
    setStalled(false);
    const result = await watchReports(
      async () => {
        const r = await call<ReportsResponse>("/api/reports");
        return r.ok
          ? { ok: true as const, items: Array.isArray(r.data.items) ? r.data.items : [] }
          : { ok: false as const, status: r.status };
      },
      (list) => {
        setItems(list);
        setState("ready");
      },
      { cancelled: () => run.current !== mine || !mounted.current },
    );
    if (result === "cancelled") return;
    if (result === "stalled") setStalled(true);
    else if (typeof result === "object") setState(result.error === 401 ? "signin" : "error");
  }, []);

  useEffect(() => {
    mounted.current = true;
    void Promise.resolve().then(load);
    return () => {
      mounted.current = false;
    };
  }, [load]);

  if (state === "loading") return <p className="text-muted">{t("loading")}</p>;
  if (state === "signin")
    return (
      <div className="space-y-3">
        <p>{t("signIn")}</p>
        <SignIn onSignedIn={() => void load()} />
      </div>
    );
  if (state === "error")
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
    <div className="space-y-4">
      <ReportItems items={items} />
      {stalled && (
        <div aria-live="polite" className="space-y-2">
          <p>{t("stillWorking")}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-sm border border-border px-4 py-2 text-sm"
          >
            {t("checkAgain")}
          </button>
        </div>
      )}
    </div>
  );
}

/** The list itself (pure, for tests): status in words, created date in IST, download if ready. */
export function ReportItems({ items }: { items: Report[] }) {
  const t = useTranslations("revenue.account");
  const tr = useTranslations("revenue");
  const locale = useLocale() as "en" | "hi";
  if (items.length === 0)
    return (
      <p data-testid="reports-empty">
        {t("empty")}{" "}
        <Link href="/reports" className="text-accent underline">
          {t("browse")}
        </Link>
      </p>
    );
  return (
    <ul className="divide-y divide-border rounded-md border border-border bg-surface">
      {items.map((r) => {
        const href = downloadHref(r);
        return (
          <li
            key={r.id}
            className="flex flex-wrap items-start justify-between gap-3 p-4"
            data-status={r.status}
          >
            <div className="min-w-0 space-y-1">
              <p className="font-medium">{r.title || tr(`sku.${r.sku}`)}</p>
              <p className="text-sm text-muted">
                {tr(`sku.${r.sku}`)} · {tr(`languages.${r.language}`)} ·{" "}
                {t("created", { date: dateTimeIst(r.created_at, locale) })}
                {r.pages ? ` · ${t("pages", { count: r.pages })}` : ""}
              </p>
              <p className="text-sm" aria-live={inProgress(r) ? "polite" : undefined}>
                <span
                  className="font-medium"
                  style={{
                    color:
                      r.status === "ready"
                        ? "var(--color-success)"
                        : r.status === "failed"
                          ? "var(--color-danger)"
                          : undefined,
                  }}
                >
                  {t(`status.${r.status}`)}
                </span>
                {" · "}
                {t(`statusHelp.${r.status}`)}
              </p>
            </div>
            {href && (
              <a
                href={href}
                download
                className="rounded-sm bg-primary px-4 py-2 text-sm font-medium text-primary-fg"
              >
                {t("download")}
              </a>
            )}
          </li>
        );
      })}
    </ul>
  );
}
