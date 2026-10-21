import { usePathname, useRouter } from "next/navigation";
import { useCallback } from "react";
import { termsHref } from "./trust";

/**
 * For client components: a portal write answered `403 consent_required` (trust.md §1) opens
 * the astrologer terms gate, which brings the astrologer back here after accepting.
 */
export function useOpenTermsGate(): () => void {
  const router = useRouter();
  const pathname = usePathname();
  return useCallback(() => router.push(termsHref(pathname)), [router, pathname]);
}
