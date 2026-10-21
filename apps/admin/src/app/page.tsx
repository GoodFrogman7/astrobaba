import Link from "next/link";
import { NotAuthorised } from "@/components/NotAuthorised";
import { api } from "@/lib/api";
import { adminPage } from "@/lib/guard";
import type { AdminAstrologerRow, AdminReview, HoroscopeEntry, Page } from "@/lib/types";

export const dynamic = "force-dynamic";

async function count<T>(load: () => Promise<Page<T>>): Promise<number | null> {
  try {
    const p = await load();
    return p.total ?? p.items.length;
  } catch {
    return null;
  }
}

export default async function Dashboard() {
  const { access, data } = await adminPage(async () => {
    const [kyc, interview, flagged, horoscopes] = await Promise.all([
      count(() =>
        api.get<Page<AdminAstrologerRow>>("/v1/admin/astrologers?status=kyc_submitted&limit=50"),
      ),
      count(() =>
        api.get<Page<AdminAstrologerRow>>("/v1/admin/astrologers?status=interview&limit=50"),
      ),
      count(() => api.get<Page<AdminReview>>("/v1/admin/reviews?status=flagged&limit=50")),
      api
        .get<HoroscopeEntry[]>("/v1/admin/horoscopes?status=pending_review&limit=200")
        .then((r) => r.length)
        .catch(() => null),
    ]);
    return { kyc, interview, flagged, horoscopes };
  });
  if (access.kind !== "admin" || !data) return <NotAuthorised />;
  const cards = [
    { label: "Documents to review", value: data.kyc, href: "/astrologers?status=kyc_submitted" },
    { label: "Interviews to record", value: data.interview, href: "/astrologers?status=interview" },
    { label: "Flagged reviews", value: data.flagged, href: "/reviews?status=flagged" },
    { label: "Horoscopes awaiting review", value: data.horoscopes, href: "/horoscopes" },
  ];
  return (
    <main id="main" className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="text-2xl font-semibold">Pending work</h1>
      <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((c) => (
          <li key={c.label}>
            <Link
              href={c.href}
              className="block rounded-md border border-border bg-surface p-5 hover:border-primary"
            >
              <span className="block text-3xl font-semibold">{c.value ?? "–"}</span>
              <span className="mt-1 block text-sm text-muted">{c.label}</span>
            </Link>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-xs text-muted">
        Counts above 50 show as 50+ only when the API returns a total. “–” means the list could not
        be loaded.
      </p>
    </main>
  );
}
