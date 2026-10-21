"use client";

import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { ApplicationForm } from "./ApplicationForm";
import { SignIn } from "./SignIn";
import { useApplicant } from "./useApplicant";

/** Apply flow: sign in, then the form; existing applicants go to their status page. */
export function ApplyGate() {
  const t = useTranslations("market.apply");
  const ts = useTranslations("market.status");
  const { state, reload } = useApplicant();
  return (
    <div id="apply" className="space-y-4" aria-live="polite">
      {state.kind === "loading" && <p className="text-muted">{ts("loading")}</p>}
      {state.kind === "signed_out" && (
        <>
          <p>{t("signInFirst")}</p>
          <SignIn source="astrologer-apply" onSignedIn={() => void reload()} />
        </>
      )}
      {state.kind === "none" && <ApplicationForm onDone={() => void reload()} />}
      {state.kind === "ready" && (
        <p>
          {t("already")}{" "}
          <Link href="/astrologers/apply/status" className="font-medium text-accent underline">
            {t("seeStatus")}
          </Link>
        </p>
      )}
      {state.kind === "error" && <p>{ts("errors.generic")}</p>}
    </div>
  );
}
