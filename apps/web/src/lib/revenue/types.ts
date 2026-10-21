import type { AiQuestion, Remedy, Report, ReportOrder, ReportProduct } from "@astro/shared";

/** Phase 6 shapes from docs/api/revenue.md (source of truth with packages/shared/src/products.ts). */
export type { AiQuestion, Remedy, Report, ReportOrder, ReportProduct };

export interface ReportProductsResponse {
  items: ReportProduct[];
}

export interface ReportsResponse {
  items: Report[];
}

/** One saved kundli as GET /v1/kundlis returns it (only the fields the pickers show). */
export interface SavedKundli {
  id: string;
  name: string;
  birth: { date: string; time: string | null; place: { label?: string | null } };
  created_at: string;
}

export interface AiConversation {
  id: string;
  kundli_id?: string;
  kundli?: { label?: string; name?: string } & Record<string, unknown>;
  questions: AiQuestion[];
  created_at?: string;
}

export interface RemedyLead {
  id: string;
  status: "new";
}
