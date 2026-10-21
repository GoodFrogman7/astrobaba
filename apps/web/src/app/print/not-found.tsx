import enReport from "../../../messages/en/report.json" with { type: "json" };
import hiReport from "../../../messages/hi/report.json" with { type: "json" };

/** Plain 404 for print pages, in both languages (the report's language is unknown here). */
export default function PrintNotFound() {
  return (
    <main className="report" data-print-error="404">
      <p>{enReport.printReport.errors["404"]}</p>
      <p lang="hi">{hiReport.printReport.errors["404"]}</p>
    </main>
  );
}
