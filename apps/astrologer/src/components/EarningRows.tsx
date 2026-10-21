import type { EarningRow } from "@astro/shared";
import { formatDeduction } from "@/lib/earnings";
import { formatIst, formatRupees } from "@/lib/format";

const COLUMNS = ["Minutes", "Gross", "Commission", "Refunds"];

/** Per-session earnings lines, as on the earnings page and in a payout statement. */
export function EarningRows({ rows, boldNet = false }: { rows: EarningRow[]; boldNet?: boolean }) {
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-border text-muted">
          <tr>
            {["Started (IST)", "Client", "Type"].map((c) => (
              <th key={c} scope="col" className="py-2 pr-4 font-medium">
                {c}
              </th>
            ))}
            {COLUMNS.map((c) => (
              <th key={c} scope="col" className="py-2 pr-4 text-right font-medium">
                {c}
              </th>
            ))}
            <th scope="col" className="py-2 text-right font-medium">
              Net
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.session_id} className="border-b border-border">
              <td className="py-2 pr-4 whitespace-nowrap">{formatIst(r.started_at)}</td>
              <td className="py-2 pr-4">{r.client_label}</td>
              <td className="py-2 pr-4">{r.kind === "call" ? "Call" : "Chat"}</td>
              <td className="py-2 pr-4 text-right tabular-nums">{r.billed_minutes}</td>
              <td className="py-2 pr-4 text-right tabular-nums">{formatRupees(r.gross_paise)}</td>
              <td className="py-2 pr-4 text-right tabular-nums">
                {formatDeduction(r.commission_paise)}
              </td>
              <td className="py-2 pr-4 text-right tabular-nums">
                {formatDeduction(r.refunds_paise)}
              </td>
              <td className={`py-2 text-right tabular-nums ${boldNet ? "font-medium" : ""}`}>
                {formatRupees(r.net_paise)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
