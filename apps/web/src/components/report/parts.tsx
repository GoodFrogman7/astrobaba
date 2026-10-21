import type { ReactNode } from "react";
import type { ReportCtx } from "@/lib/report/context";

/** One report section. Every section after the cover starts on a new page. */
export function Section({
  id,
  title,
  children,
  className,
}: {
  id: string;
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      id={id}
      data-section={id}
      className={`r-section${className ? ` ${className}` : ""}`}
      aria-labelledby={`${id}-h`}
    >
      <h2 id={`${id}-h`} className="r-h2">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** The fixed "How to read this" note: product copy, never generated. */
export function HowTo({ c, paras }: { c: ReportCtx; paras: string[] }) {
  return (
    <aside className="r-howto" data-howto="">
      <h3 className="r-howto-h">{c.t("howToRead")}</h3>
      {paras.map((p) => (
        <p key={p.slice(0, 40)}>{p}</p>
      ))}
    </aside>
  );
}

/** Same rule as the site (components/tools/Results PendingReview): shown unless verified. */
export function ReviewNote({ c, status }: { c: ReportCtx; status: string | undefined }) {
  if (status === "verified") return null;
  return (
    <p className="r-review" data-review={status ?? "unknown"}>
      <strong>{c.t("common.pendingTitle")}:</strong> {c.tr("pendingReview")}
    </p>
  );
}

/** Two-column label/value table. */
export function Facts({ rows, className }: { rows: [string, ReactNode][]; className?: string }) {
  return (
    <table className={`r-table r-facts${className ? ` ${className}` : ""}`}>
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k}>
            <th scope="row">{k}</th>
            <td>{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function H3({ children }: { children: ReactNode }) {
  return <h3 className="r-h3">{children}</h3>;
}

/** The engine's rule text, quoted as applied (English in both languages, labelled as such). */
export function Rule({ c, text }: { c: ReportCtx; text: string }) {
  return (
    <p className="r-rule">
      <span className="r-muted">{c.t("common.engineRule")}:</span> {text}
    </p>
  );
}
