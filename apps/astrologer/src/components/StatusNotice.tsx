import { STATUS_TEXT, type Access } from "@/lib/access";
import { applicationStatusUrl } from "@/lib/site";

/** Shown instead of the console when the signed-in user is not a live astrologer. */
export function StatusNotice({ access }: { access: Exclude<Access, { kind: "live" | "anon" }> }) {
  const text =
    access.kind === "not_live"
      ? STATUS_TEXT[access.status]
      : "This account has no astrologer application.";
  return (
    <main id="main" className="mx-auto max-w-xl px-4 py-16">
      <h1 className="text-2xl font-semibold">You are not live yet</h1>
      <p className="mt-3">{text}</p>
      <p className="mt-2 text-muted">
        The console opens once your profile is live (on probation or approved).
      </p>
      <p className="mt-4">
        <a href={applicationStatusUrl()} className="underline">
          See your application status on the public site
        </a>
      </p>
      <form action="/api/auth/logout" method="post" className="mt-6">
        <button className="rounded-sm border border-border px-3 py-2">Sign out</button>
      </form>
    </main>
  );
}
