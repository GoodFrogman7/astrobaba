import { NextResponse, type NextRequest } from "next/server";
import { validateBirth } from "@/lib/tools/validate";
import type { BirthInput } from "@/lib/tools/types";
import { errorResponse, sessionToken } from "@/lib/tools/proxy";
import { api } from "@/lib/upstream";

/** Save a kundli for the signed-in user. Birth details travel in the body only. */
export async function POST(req: NextRequest) {
  const token = await sessionToken();
  if (!token) return NextResponse.json({ code: "not_signed_in" }, { status: 401 });
  let body: { name?: string; birth?: BirthInput };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ code: "invalid_body" }, { status: 400 });
  }
  const name = (body.name ?? "").trim();
  if (!name || name.length > 60)
    return NextResponse.json({ code: "name_required" }, { status: 422 });
  const errors = validateBirth(body.birth);
  if (errors.length || !body.birth)
    return NextResponse.json({ code: errors[0] ?? "invalid" }, { status: 422 });
  const b = body.birth;
  try {
    const saved = await api.post<{ id: string }>(
      "/v1/kundlis",
      {
        name,
        birth: {
          date: b.date,
          time: b.time,
          place: {
            lat: b.place.lat,
            lon: b.place.lon,
            tz: b.place.tz,
            ...(b.place.label ? { label: b.place.label } : {}),
            ...(b.place.city_id ? { city_id: b.place.city_id } : {}),
          },
          ...(b.fold !== undefined ? { fold: b.fold } : {}),
        },
      },
      token,
    );
    return NextResponse.json({ id: saved.id }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function GET() {
  const token = await sessionToken();
  if (!token) return NextResponse.json({ code: "not_signed_in" }, { status: 401 });
  try {
    return NextResponse.json(await api.get("/v1/kundlis", token));
  } catch (e) {
    return errorResponse(e);
  }
}
