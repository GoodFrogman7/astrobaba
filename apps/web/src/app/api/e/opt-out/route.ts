import { NextResponse, type NextRequest } from "next/server";
import { clearAid, setOptOut } from "@/lib/analytics/server";

/** Privacy page switch (docs/api/growth.md §1.1): turn analytics off for this browser. */
export async function POST(req: NextRequest) {
  const res = new NextResponse(null, { status: 204 });
  setOptOut(res, req, true);
  clearAid(res, req);
  return res;
}

/** Turn analytics back on: removes aid_off. A new `aid` is set with the next accepted events. */
export async function DELETE(req: NextRequest) {
  const res = new NextResponse(null, { status: 204 });
  setOptOut(res, req, false);
  return res;
}
