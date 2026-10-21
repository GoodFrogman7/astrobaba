import createMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";

export default createMiddleware(routing);

export const config = {
  // Skip API routes, the print-only report pages (no locale prefix, no auth: the signed URL is
  // the credential), Next internals and files with an extension.
  matcher: "/((?!api|print/|_next|_vercel|.*\\..*).*)",
};
