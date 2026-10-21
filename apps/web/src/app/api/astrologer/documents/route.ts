import type { NextRequest } from "next/server";
import { forwardUpload } from "@/lib/marketplace/proxy";

/** KYC document upload: streamed to the API, never stored on the web server. */
export async function POST(req: NextRequest) {
  return forwardUpload(req, "/v1/astrologer/me/documents");
}
