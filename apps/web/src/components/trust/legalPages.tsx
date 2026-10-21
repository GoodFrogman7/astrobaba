import "server-only";

import { BRAND_NAME, type Locale } from "@astro/shared";
import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { AnalyticsSwitch } from "@/components/analytics/AnalyticsSwitch";
import { routing } from "@/i18n/routing";
import { AID_COOKIE_DAYS, ANALYTICS_RETENTION_DAYS } from "@/lib/analytics/config";
import { BILLING } from "@/lib/billing/config";
import { formatPaise } from "@/lib/marketplace/format";
import { pageMetadata } from "@/lib/seo";
import { fillLegal, getLegalContent, type LegalContent } from "@/lib/trust/content";
import { loadLegal, loadSafetyResources } from "@/lib/trust/legal";
import { LEGAL_PATHS, type LegalPageKey } from "@/lib/trust/pages";
import { creditPolicy, refundRules } from "@/lib/trust/policy";
import type { LegalInfo } from "@/lib/trust/types";
import { HelplineList } from "./CrisisPanel";
import { LegalPage, Pending } from "./LegalPage";

/** Values the legal texts quote, all from configuration (never typed into the copy). */
function values(): Record<string, string | number> {
  return {
    brand: BRAND_NAME,
    minStart: BILLING.minStartMinutes,
    grace: BILLING.heartbeatGraceSeconds,
    promoDays: BILLING.promoExpiryDays,
    aidDays: AID_COOKIE_DAYS,
    retentionDays: ANALYTICS_RETENTION_DAYS,
  };
}

async function content(locale: Locale, page: LegalPageKey): Promise<LegalContent> {
  return fillLegal(await getLegalContent(locale, page), values());
}

export type Props = { params: Promise<{ locale: string }> };

export async function legalMetadata({ params }: Props, page: LegalPageKey): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  return pageMetadata(locale, LEGAL_PATHS[page], await content(locale, page));
}

/** Render one policy page with its data blocks. */
export async function renderLegalPage({ params }: Props, page: LegalPageKey) {
  const { locale: raw } = await params;
  if (!hasLocale(routing.locales, raw)) notFound();
  const locale: Locale = raw;
  setRequestLocale(locale);
  const [c, legal] = await Promise.all([content(locale, page), loadLegal()]);
  const slots = await SLOTS[page](locale, legal);
  return (
    <LegalPage
      locale={locale}
      page={page}
      content={c}
      version={legal.version}
      status={legal.status}
      slots={slots}
    />
  );
}

type SlotBuilder = (locale: Locale, legal: LegalInfo) => Promise<Record<string, ReactNode>>;

const dl =
  "grid gap-x-4 gap-y-2 rounded-md border border-border bg-surface p-4 sm:grid-cols-[14rem_1fr]";

async function operatorBlock(locale: Locale, legal: LegalInfo) {
  const t = await getTranslations({ locale, namespace: "trust.privacy" });
  const tl = await getTranslations({ locale, namespace: "trust.legal" });
  const v = (x: string | null) => x ?? <Pending text={tl("toBePublished")} />;
  return (
    <dl className={dl} data-testid="operator">
      <dt className="text-muted">{t("operatorName")}</dt>
      <dd>{v(legal.operator.legal_name)}</dd>
      <dt className="text-muted">{t("operatorAddress")}</dt>
      <dd>{v(legal.operator.address)}</dd>
      <dt className="text-muted">
        {t("grievanceHeading")}: {t("grievanceName")}
      </dt>
      <dd>{v(legal.grievance_officer.name)}</dd>
      <dt className="text-muted">
        {t("grievanceHeading")}: {t("grievanceEmail")}
      </dt>
      <dd>
        {legal.grievance_officer.email ? (
          <a href={`mailto:${legal.grievance_officer.email}`} className="text-accent underline">
            {legal.grievance_officer.email}
          </a>
        ) : (
          <Pending text={tl("toBePublished")} />
        )}
      </dd>
    </dl>
  );
}

async function processorsBlock(locale: Locale, legal: LegalInfo) {
  const t = await getTranslations({ locale, namespace: "trust.privacy" });
  const tl = await getTranslations({ locale, namespace: "trust.legal" });
  // English shows the registry's own words; Hindi shows the translation for a known provider.
  const text = (id: string, field: "purpose" | "data", fallback: string) =>
    locale !== "en" && t.has(`processorText.${id}.${field}`)
      ? t(`processorText.${id}.${field}`)
      : fallback;
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">{t("processorsIntro")}</p>
      <ul className="space-y-3" data-testid="processors">
        {legal.processors.map((p) => (
          <li key={p.id} className="rounded-md border border-border p-4" data-processor={p.id}>
            <p className="font-semibold">
              {t.has(`names.${p.id}`) ? t(`names.${p.id}`) : p.id}
              {p.founder_to_fill ? (
                <>
                  {" · "}
                  <Pending text={t("providerPending")} />
                </>
              ) : null}
            </p>
            <dl className="mt-2 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[8rem_1fr]">
              <dt className="text-muted">{t("purpose")}</dt>
              <dd>{text(p.id, "purpose", p.purpose)}</dd>
              <dt className="text-muted">{t("data")}</dt>
              <dd>{text(p.id, "data", p.data)}</dd>
              <dt className="text-muted">{t("region")}</dt>
              <dd>
                {p.region ? (
                  p.region === "India" ? (
                    t("regionIndia")
                  ) : (
                    p.region
                  )
                ) : (
                  <Pending text={tl("toBePublished")} />
                )}
              </dd>
            </dl>
          </li>
        ))}
      </ul>
    </div>
  );
}

async function retentionBlock(locale: Locale, legal: LegalInfo) {
  const t = await getTranslations({ locale, namespace: "trust.privacy" });
  const proposed = legal.retention.proposed ?? {};
  const rows = Object.entries(proposed).filter(([, v]) => typeof v === "string");
  return (
    <div className="space-y-2">
      <dl className={dl} data-testid="retention">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted">
              {t.has(`retentionKeys.${k}`) ? t(`retentionKeys.${k}`) : k}
            </dt>
            <dd>{locale !== "en" && t.has(`retentionText.${k}`) ? t(`retentionText.${k}`) : v}</dd>
          </div>
        ))}
      </dl>
      <p className="text-sm text-muted">{t("retentionNote")}</p>
    </div>
  );
}

async function refundRulesBlock(locale: Locale) {
  const t = await getTranslations({ locale, namespace: "trust.refunds" });
  const rules = refundRules().filter((r) => t.has(`rules.${r.id}`));
  if (!rules.length) return <p>{t("noRules")}</p>;
  return (
    <ul className="list-disc space-y-2 pl-5" data-testid="refund-rules">
      {rules.map((r) => (
        <li key={r.id} data-rule={r.id} className="leading-relaxed">
          {t(`rules.${r.id}`, {
            ...r.params,
            cap: r.params.capPaise !== undefined ? formatPaise(r.params.capPaise, locale) : "",
          })}
        </li>
      ))}
    </ul>
  );
}

async function creditFactsBlock(locale: Locale) {
  const t = await getTranslations({ locale, namespace: "trust.credit" });
  const p = creditPolicy();
  const fmt = (paise: number) => formatPaise(paise, locale);
  const tiers = p.bonus.tiers
    .map((x) => t("bonusTier", { percent: x.percent, amount: fmt(x.minPaise) }))
    .join("; ");
  return (
    <dl className={dl} data-testid="credit-facts">
      <dt className="text-muted">{t("spendOrder")}</dt>
      <dd>{t("spendOrderValue")}</dd>
      <dt className="text-muted">{t("promoExpiry")}</dt>
      <dd data-testid="promo-expiry">{t("promoExpiryValue", { days: p.promoExpiryDays })}</dd>
      <dt className="text-muted">{t("realExpiry")}</dt>
      <dd data-testid="real-expiry">{t("realExpiryValue", { days: p.realExpiryDays })}</dd>
      <dt className="text-muted">{t("rechargeLimits")}</dt>
      <dd>
        {t("rechargeLimitsValue", {
          min: fmt(p.minRechargePaise),
          max: fmt(p.maxRechargePaise),
        })}
      </dd>
      <dt className="text-muted">{t("bonus")}</dt>
      <dd>{p.bonus.enabled && tiers ? t("bonusOn", { tiers }) : t("bonusOff")}</dd>
      <dt className="text-muted">{t("free")}</dt>
      <dd>
        {p.freeSession.enabled ? t("freeOn", { minutes: p.freeSession.minutes }) : t("freeOff")}
      </dd>
    </dl>
  );
}

async function helplinesBlock(locale: Locale) {
  const resources = await loadSafetyResources();
  const t = await getTranslations({ locale, namespace: "trust.safety" });
  return (
    <div className="space-y-4">
      <p
        className="rounded-md border-2 border-accent bg-surface p-4 font-medium"
        data-testid="not-a-helpline"
      >
        {resources.not_a_helpline[locale]}
      </p>
      <h3 className="sr-only">{t("pageHelplines")}</h3>
      <HelplineList resources={resources} locale={locale} />
    </div>
  );
}

const SLOTS: Record<LegalPageKey, SlotBuilder> = {
  terms: async () => ({}),
  privacy: async (locale, legal) => ({
    operator: await operatorBlock(locale, legal),
    processors: await processorsBlock(locale, legal),
    retention: await retentionBlock(locale, legal),
    analytics: <AnalyticsSwitch />,
  }),
  refunds: async (locale) => ({ rules: await refundRulesBlock(locale) }),
  credit: async (locale) => ({ facts: await creditFactsBlock(locale) }),
  grievance: async (locale, legal) => ({ contact: await operatorBlock(locale, legal) }),
  safety: async (locale) => ({ helplines: await helplinesBlock(locale) }),
};
