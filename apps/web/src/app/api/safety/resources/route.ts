import { publicGet } from "@/lib/revenue/route";

/** Crisis resources (public): data/safety/helplines.json as the API serves it. */
export async function GET() {
  return publicGet("/v1/safety/resources");
}
