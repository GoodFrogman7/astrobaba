import type { Metadata } from "next";
import { applicationStatusUrl, publicSiteUrl } from "@/lib/site";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

export default function LoginPage() {
  return (
    <main id="main" className="mx-auto max-w-sm px-4 py-16">
      <h1 className="text-2xl font-semibold">Astrologer sign in</h1>
      <p className="mt-2 text-sm text-muted">
        We text a one-time code to the number you applied with.
      </p>
      <LoginForm
        applyUrl={`${publicSiteUrl()}/astrologers/apply`}
        statusUrl={applicationStatusUrl()}
      />
    </main>
  );
}
