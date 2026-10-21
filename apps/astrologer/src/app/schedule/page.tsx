import type { Availability } from "@astro/shared";
import type { Metadata } from "next";
import { StatusNotice } from "@/components/StatusNotice";
import { api, ApiError } from "@/lib/api";
import { consolePage } from "@/lib/guard";
import { ScheduleEditor } from "./ScheduleEditor";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Schedule" };

export default async function SchedulePage() {
  const { access, data } = await consolePage(async () => {
    try {
      return {
        ok: true as const,
        value: await api.get<Availability>("/v1/astrologer/me/availability"),
      };
    } catch (e) {
      return { ok: false as const, error: e instanceof ApiError ? e.message || e.code : "error" };
    }
  });
  if (access.kind === "anon") return null;
  if (access.kind !== "live" || !data) {
    return access.kind === "live" ? null : <StatusNotice access={access} />;
  }
  return (
    <main id="main" className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="text-2xl font-semibold">Weekly schedule</h1>
      <p className="mt-2 text-sm text-muted">
        Tell clients when they can usually find you. Times are India Standard Time (IST). The
        schedule is shown on your public profile; it does not switch you online or offline. Use the
        Online button on the console for that.
      </p>
      {data.ok ? (
        <ScheduleEditor initial={data.value.slots ?? []} />
      ) : (
        <p
          role="alert"
          className="mt-6 rounded-md border border-danger px-4 py-3 text-sm text-danger"
        >
          Could not load your schedule: {data.error}. Reload the page to try again.
        </p>
      )}
    </main>
  );
}
