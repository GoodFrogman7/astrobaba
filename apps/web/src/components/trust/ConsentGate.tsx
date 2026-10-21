"use client";

import type { ConsentKind, ConsentState } from "@astro/shared";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { Dialog } from "@/components/billing/Dialog";
import { rawCall } from "@/lib/billing/client";
import {
  dismissedThisSession,
  kindsToAsk,
  rememberDismissed,
  requestConsent,
  setConsentHandler,
  stripSignedIn,
  type ConsentsResponse,
} from "@/lib/trust/consent";
import { ConsentForm } from "./ConsentForm";

/** Fired after consents change, so open pages (e.g. /account) can re-read them. */
export const CONSENTS_CHANGED = "astro:consents-changed";

type Open = { state: ConsentState; kinds: ConsentKind[] };

/**
 * The one consent step of the page, mounted in the layout. It opens:
 * - after OTP sign-in (`SignIn` asks for it) and on page load, when GET /api/me/consents says
 *   the signed-in user's consents are not current ("Not now" hides the page-load reminder for
 *   the rest of the browser session);
 * - whenever a request answers `403 consent_required`; that request is sent again once the
 *   user accepts (see `call` in lib/billing/client.ts).
 * Signed-out visitors never see it.
 */
export function ConsentGate() {
  const t = useTranslations("trust.consent");
  const [open, setOpen] = useState<Open | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  useEffect(() => {
    const off = setConsentHandler(async (missing) => {
      const r = await rawCall<ConsentsResponse>("/api/me/consents");
      if (!r.ok || !r.data.signed_in) return false;
      const state = stripSignedIn(r.data);
      if (state.current) return true;
      return new Promise<boolean>((resolve) => {
        resolver.current = resolve;
        setOpen({ state, kinds: kindsToAsk(state, missing) });
      });
    });
    if (!dismissedThisSession()) void requestConsent();
    return () => {
      off();
      resolver.current?.(false);
      resolver.current = null;
    };
  }, []);

  function finish(ok: boolean) {
    const resolve = resolver.current;
    resolver.current = null;
    setOpen(null);
    if (ok) window.dispatchEvent(new Event(CONSENTS_CHANGED));
    else rememberDismissed();
    resolve?.(ok);
  }

  return (
    <Dialog
      open={open !== null}
      onClose={() => resolver.current && finish(false)}
      title={t("title")}
      closeLabel={t("later")}
    >
      {open && (
        <ConsentForm state={open.state} kinds={open.kinds} onAccepted={() => finish(true)} />
      )}
    </Dialog>
  );
}
