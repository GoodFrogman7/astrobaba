import { publicGet } from "@/lib/revenue/route";

/** Report products and prices (public; docs/api/revenue.md §2.1). */
export async function GET() {
  return publicGet("/v1/reports/products");
}
