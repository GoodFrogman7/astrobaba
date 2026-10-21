/**
 * Reports, AI assistant and remedies shapes. Source of truth: docs/api/revenue.md. Money is
 * integer paise.
 */

export const REPORT_SKUS = ["kundli_report", "matching_report"] as const;
export type ReportSku = (typeof REPORT_SKUS)[number];
export type ReportLanguage = "en" | "hi";

export interface ReportProduct {
  sku: ReportSku;
  price_paise: number;
  languages: ReportLanguage[];
  pages_estimate: number;
}

export interface ReportOrder {
  id: string;
  sku: ReportSku;
  language: ReportLanguage;
  status: "created" | "paid" | "failed";
  price_paise: number;
  pay_with: "wallet" | "razorpay";
  provider_order_id: string | null;
  key_id: string | null;
  report_id: string | null;
  created_at: string;
  paid_at: string | null;
}

export interface Report {
  id: string;
  sku: ReportSku;
  language: ReportLanguage;
  status: "queued" | "rendering" | "ready" | "failed";
  title: string;
  created_at: string;
  ready_at: string | null;
  pages: number | null;
  /** Short-lived signed link; only when ready. */
  download_url: string | null;
}

export interface AiQuestion {
  id: string;
  text: string;
  status: "queued" | "answered" | "blocked" | "failed";
  answer: string | null;
  blocked_reason: string | null;
  created_at: string;
  answered_at: string | null;
  price_paise: number;
  refunded: boolean;
}

export interface Remedy {
  id: string;
  kind: "puja" | "consultation_followup";
  name: { en: string; hi: string };
  description: { en: string; hi: string };
  price_note: { en: string; hi: string };
}
