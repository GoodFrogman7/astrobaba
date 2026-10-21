import type { Metadata } from "next";
import Link from "next/link";
import { NotAuthorised } from "@/components/NotAuthorised";
import { api } from "@/lib/api";
import { adminPage } from "@/lib/guard";
import { STATUSES, type AdminAstrologerRow, type AstrologerStatus, type Page } from "@/lib/types";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Astrologers" };

const LABEL: Record<AstrologerStatus, string> = {
  applied: "Applied",
  kyc_submitted: "Documents in",
  interview: "Interview",
  probation: "Probation",
  approved: "Approved",
  suspended: "Suspended",
  rejected: "Rejected",
};

export default async function AstrologersPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string; cursor?: string }>;
}) {
  const sp = await searchParams;
  const status = (STATUSES as string[]).includes(sp.status ?? "")
    ? (sp.status as AstrologerStatus)
    : "kyc_submitted";
  const q = (sp.q ?? "").slice(0, 80);
  const cursor = sp.cursor ?? "";
  const { access, data } = await adminPage(() => {
    const params = new URLSearchParams({ status, limit: "25" });
    if (q) params.set("q", q);
    if (cursor) params.set("cursor", cursor);
    return api.get<Page<AdminAstrologerRow>>(`/v1/admin/astrologers?${params}`);
  });
  if (access.kind !== "admin" || !data) return <NotAuthorised />;

  const link = (extra: Record<string, string>) =>
    `/astrologers?${new URLSearchParams({ status, ...(q ? { q } : {}), ...extra })}`;

  return (
    <main id="main" className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="text-2xl font-semibold">Astrologers</h1>
      <nav aria-label="Status" className="mt-4 overflow-x-auto">
        <ul className="flex gap-1 text-sm">
          {STATUSES.map((s) => (
            <li key={s}>
              <Link
                href={`/astrologers?status=${s}`}
                aria-current={s === status ? "page" : undefined}
                className={`inline-block rounded-sm px-3 py-1.5 ${
                  s === status ? "bg-primary text-primary-fg" : "border border-border"
                }`}
              >
                {LABEL[s]}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <form className="mt-4 flex gap-2" role="search">
        <input type="hidden" name="status" value={status} />
        <label htmlFor="q" className="sr-only">
          Search by name or slug
        </label>
        <input
          id="q"
          name="q"
          defaultValue={q}
          placeholder="Search by name or slug"
          className="w-full max-w-sm rounded-sm border border-border bg-surface px-3 py-1.5"
        />
        <button className="rounded-sm border border-border px-3 py-1.5 text-sm">Search</button>
      </form>

      {data.items.length === 0 ? (
        <p className="mt-8 text-muted">Nothing in “{LABEL[status]}”.</p>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className="py-2 pr-3">
                  Name
                </th>
                <th scope="col" className="py-2 pr-3">
                  Status
                </th>
                <th scope="col" className="py-2 pr-3">
                  Tier
                </th>
                <th scope="col" className="py-2 pr-3">
                  Applied
                </th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((a) => (
                <tr key={a.id} className="border-b border-border">
                  <td className="py-2 pr-3">
                    <Link
                      href={`/astrologers/${a.id}`}
                      className="font-medium underline-offset-2 hover:underline"
                    >
                      {a.display_name}
                    </Link>
                    {a.is_seed && (
                      <span className="ml-2 rounded-sm bg-accent px-1.5 py-0.5 text-xs text-accent-fg">
                        demo
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-3">{LABEL[a.status] ?? a.status}</td>
                  <td className="py-2 pr-3">{a.tier ?? "–"}</td>
                  <td className="py-2 pr-3">{a.created_at.slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-4 flex gap-3 text-sm">
        {cursor && (
          <Link href={link({})} className="underline">
            First page
          </Link>
        )}
        {data.next_cursor && (
          <Link href={link({ cursor: data.next_cursor })} className="underline">
            Next page
          </Link>
        )}
        {typeof data.total === "number" && (
          <span className="text-muted">{data.total} in total</span>
        )}
      </div>
    </main>
  );
}
