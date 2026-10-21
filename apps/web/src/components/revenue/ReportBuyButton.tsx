"use client";

import type { ReportSku } from "@astro/shared";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Dialog } from "@/components/billing/Dialog";
import type { ReportProduct } from "@/lib/revenue/types";
import { BuyFlow } from "./BuyFlow";

/**
 * The buy button on the static /reports page. The server and the first client render are the
 * same plain button (no data, no cookies, no layout shift); the flow loads in a dialog on click.
 */
export function ReportBuyButton({
  sku,
  products,
}: {
  sku: ReportSku;
  products: ReportProduct[] | null;
}) {
  const t = useTranslations("revenue.buy");
  const tr = useTranslations("revenue");
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-sm bg-primary px-5 py-2 font-medium text-primary-fg"
        data-testid={`buy-${sku}`}
      >
        {t("button", { name: tr(`sku.${sku}`) })}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={t("title")} closeLabel={t("close")}>
        <BuyFlow initialSku={sku} products={products} />
      </Dialog>
    </>
  );
}
