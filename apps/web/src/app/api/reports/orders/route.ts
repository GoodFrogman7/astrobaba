import { REPORT_SKUS, type ReportSku } from "@astro/shared";
import { NextResponse, type NextRequest } from "next/server";
import { EMAIL } from "@/lib/revenue/buy";
import { forward, ID, invalidBody, readJson } from "@/lib/billing/forward";
import { KUNDLIS_PER_SKU } from "@/lib/revenue/config";
import { missingIdempotencyKey } from "@/lib/revenue/route";

const unprocessable = (code: string) => NextResponse.json({ code }, { status: 422 });

/**
 * Buy a report (docs/api/revenue.md §2.1). Only the contract's fields are forwarded, with the
 * browser's Idempotency-Key; the email (optional) travels in the body only and is never logged.
 */
export async function POST(req: NextRequest) {
  const body = await readJson(req);
  if (!body) return invalidBody();
  const missing = missingIdempotencyKey(req);
  if (missing) return missing;
  const { sku, language, kundli_ids: ids, pay_with: payWith, email } = body;
  if (typeof sku !== "string" || !REPORT_SKUS.includes(sku as ReportSku))
    return unprocessable("invalid_sku");
  if (language !== "en" && language !== "hi") return unprocessable("invalid_language");
  if (
    !Array.isArray(ids) ||
    ids.length !== KUNDLIS_PER_SKU[sku as ReportSku] ||
    !ids.every((i) => typeof i === "string" && ID.test(i)) ||
    new Set(ids).size !== ids.length
  )
    return unprocessable("invalid_kundli_ids");
  if (payWith !== "wallet" && payWith !== "razorpay") return unprocessable("invalid_pay_with");
  if (email !== undefined && email !== null && (typeof email !== "string" || !EMAIL.test(email)))
    return unprocessable("invalid_email");
  return forward(req, {
    method: "POST",
    path: "/v1/reports/orders",
    body: {
      sku,
      language,
      kundli_ids: ids,
      pay_with: payWith,
      ...(typeof email === "string" ? { email } : {}),
    },
  });
}
